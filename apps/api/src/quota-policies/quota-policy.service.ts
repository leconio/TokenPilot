import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import {
  AiuQuotaPolicyScope,
  materializeEffectiveAiuQuotaPolicy,
  Prisma,
  QuotaPeriodType,
  type AiuQuotaPolicyDatabase,
  type DatabaseClient,
  type EffectiveAiuQuotaPolicy,
} from "@tokenpilot/db";

import { AuditContextService } from "../audit-context.js";
import { AuditService } from "../audit.service.js";
import { DATABASE_CLIENT } from "../tokens.js";
import { aiuToMicros, userQuotaPeriodTypes } from "../users/user-presentation.js";
import { quotaPeriodWindow } from "../users/quota-period.js";
import { disableQuotaPolicySchema, saveQuotaPolicySchema } from "./quota-policy.schemas.js";

type QuotaPolicyTransaction = Pick<
  DatabaseClient,
  | "application"
  | "applicationUser"
  | "applicationUserGroup"
  | "aiuQuotaPolicy"
  | "userAiuQuota"
  | "userAiuReservation"
  | "userAiuLedgerEntry"
  | "auditLog"
>;

function present(policy: {
  readonly id: string;
  readonly scope: AiuQuotaPolicyScope;
  readonly userId: string | null;
  readonly userGroupId: string | null;
  readonly limitAiuMicros: bigint;
  readonly hardLimit: boolean;
  readonly periodType: QuotaPeriodType;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly priority: number;
  readonly enabled: boolean;
  readonly updatedAt: Date;
  readonly user?: { readonly externalId: string; readonly name: string | null } | null;
  readonly userGroup?: { readonly name: string } | null;
}) {
  const period =
    policy.periodType === QuotaPeriodType.CALENDAR_DAY
      ? "day"
      : policy.periodType === QuotaPeriodType.CALENDAR_WEEK
        ? "week"
        : policy.periodType === QuotaPeriodType.CALENDAR_MONTH
          ? "month"
          : policy.periodType === QuotaPeriodType.FIXED_WINDOW
            ? "fixed"
            : "lifetime";
  return {
    id: policy.id,
    scope: policy.scope.toLowerCase(),
    user_id: policy.userId,
    user_group_id: policy.userGroupId,
    subject_name: policy.user?.name ?? policy.user?.externalId ?? policy.userGroup?.name ?? null,
    limit_aiu_micros: policy.limitAiuMicros.toString(),
    hard_limit: policy.hardLimit,
    period,
    starts_at: policy.startsAt?.toISOString() ?? null,
    ends_at: policy.endsAt?.toISOString() ?? null,
    priority: policy.priority,
    enabled: policy.enabled,
    updated_at: policy.updatedAt.toISOString(),
  };
}

@Injectable()
export class AiuQuotaPolicyService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(AuditContextService) private readonly context: AuditContextService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private applicationId(): string {
    const applicationId = this.context.current().applicationId;
    if (applicationId === undefined)
      throw new ForbiddenException("An application context is required");
    return applicationId;
  }

  async list() {
    const policies = await this.database.aiuQuotaPolicy.findMany({
      where: { applicationId: this.applicationId() },
      include: {
        user: { select: { externalId: true, name: true } },
        userGroup: { select: { name: true } },
      },
      orderBy: [{ scope: "asc" }, { priority: "desc" }, { updatedAt: "desc" }],
    });
    return { policies: policies.map(present) };
  }

  saveApplication(input: unknown) {
    return this.save(AiuQuotaPolicyScope.APPLICATION, null, input);
  }

  saveUserGroup(groupId: string, input: unknown) {
    return this.save(AiuQuotaPolicyScope.USER_GROUP, groupId, input);
  }

  disableApplication(input: unknown) {
    return this.disable(AiuQuotaPolicyScope.APPLICATION, null, input);
  }

  disableUserGroup(groupId: string, input: unknown) {
    return this.disable(AiuQuotaPolicyScope.USER_GROUP, groupId, input);
  }

  private async save(scope: AiuQuotaPolicyScope, subjectId: string | null, input: unknown) {
    const parsed = saveQuotaPolicySchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid AIU quota rule");
    const applicationId = this.applicationId();
    const value = parsed.data;
    return this.database.$transaction(
      async (transaction) => {
        const { timezone, userIds } = await this.subject(
          transaction,
          applicationId,
          scope,
          subjectId,
        );
        const existing = await transaction.aiuQuotaPolicy.findFirst({
          where: {
            applicationId,
            scope,
            ...(scope === AiuQuotaPolicyScope.USER_GROUP ? { userGroupId: subjectId } : {}),
          },
        });
        const data = {
          limitAiuMicros: aiuToMicros(value.limit),
          hardLimit: value.hard_limit,
          periodType: userQuotaPeriodTypes[value.period],
          startsAt: value.period === "fixed" ? new Date(value.starts_at!) : null,
          endsAt: value.period === "fixed" ? new Date(value.ends_at!) : null,
          priority: value.priority,
          enabled: true,
        } as const;
        const policy =
          existing === null
            ? await transaction.aiuQuotaPolicy.create({
                data: {
                  applicationId,
                  scope,
                  ...(scope === AiuQuotaPolicyScope.USER_GROUP ? { userGroupId: subjectId } : {}),
                  ...data,
                },
              })
            : await transaction.aiuQuotaPolicy.update({ where: { id: existing.id }, data });
        await this.materialize(transaction, applicationId, userIds, timezone, value.reason);
        await this.audit.record(
          {
            action: "aiu_quota_policy.save",
            objectType: "aiu_quota_policy",
            objectId: policy.id,
            before: existing === null ? undefined : present(existing),
            after: present(policy),
            reason: value.reason,
          },
          transaction,
        );
        return present(policy);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async disable(scope: AiuQuotaPolicyScope, subjectId: string | null, input: unknown) {
    const parsed = disableQuotaPolicySchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("A reason is required");
    const applicationId = this.applicationId();
    return this.database.$transaction(
      async (transaction) => {
        const { timezone, userIds } = await this.subject(
          transaction,
          applicationId,
          scope,
          subjectId,
        );
        const existing = await transaction.aiuQuotaPolicy.findFirst({
          where: {
            applicationId,
            scope,
            ...(scope === AiuQuotaPolicyScope.USER_GROUP ? { userGroupId: subjectId } : {}),
          },
        });
        if (existing === null) throw new NotFoundException("AIU quota rule not found");
        const policy = await transaction.aiuQuotaPolicy.update({
          where: { id: existing.id },
          data: { enabled: false },
        });
        await this.materialize(transaction, applicationId, userIds, timezone, parsed.data.reason);
        await this.audit.record(
          {
            action: "aiu_quota_policy.disable",
            objectType: "aiu_quota_policy",
            objectId: policy.id,
            before: present(existing),
            after: present(policy),
            reason: parsed.data.reason,
          },
          transaction,
        );
        return present(policy);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async subject(
    database: QuotaPolicyTransaction,
    applicationId: string,
    scope: AiuQuotaPolicyScope,
    subjectId: string | null,
  ) {
    const application = await database.application.findUniqueOrThrow({
      where: { id: applicationId },
      select: { timezone: true },
    });
    if (scope === AiuQuotaPolicyScope.APPLICATION) {
      const users = await database.applicationUser.findMany({
        where: { applicationId },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      return { timezone: application.timezone, userIds: users.map((user) => user.id) };
    }
    const group = await database.applicationUserGroup.findFirst({
      where: { applicationId, id: subjectId ?? "" },
      select: {
        definitionVersion: true,
        evaluations: {
          orderBy: { evaluatedAt: "desc" },
          take: 1,
          select: {
            definitionVersion: true,
            members: { select: { userId: true }, orderBy: { userId: "asc" } },
          },
        },
      },
    });
    if (group === null) throw new NotFoundException("User group not found");
    const evaluation = group.evaluations[0];
    if (evaluation === undefined || evaluation.definitionVersion !== group.definitionVersion) {
      throw new BadRequestException("Refresh the user group before setting its quota rule");
    }
    return {
      timezone: application.timezone,
      userIds: evaluation.members.map((member) => member.userId),
    };
  }

  private async materialize(
    database: QuotaPolicyTransaction,
    applicationId: string,
    userIds: readonly string[],
    timezone: string,
    reason: string,
  ) {
    for (const userId of userIds) {
      await materializeEffectiveAiuQuotaPolicy(database as unknown as AiuQuotaPolicyDatabase, {
        applicationId,
        userId,
        reason,
        window: (policy: EffectiveAiuQuotaPolicy) =>
          policy.periodType === QuotaPeriodType.FIXED_WINDOW
            ? { start: policy.startsAt!, end: policy.endsAt! }
            : quotaPeriodWindow(policy.periodType, timezone, new Date()),
      });
    }
  }
}

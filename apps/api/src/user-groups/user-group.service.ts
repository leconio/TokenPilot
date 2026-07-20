import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import {
  AiuQuotaPolicyScope,
  aiuQuotaPeriodWindow,
  materializeEffectiveAiuQuotaPolicy,
  Prisma,
  QuotaPeriodType,
  type AiuQuotaPolicyDatabase,
  type DatabaseClient,
} from "@tokenpilot/db";

import { AuditContextService } from "../audit-context.js";
import { AuditService } from "../audit.service.js";
import { DATABASE_CLIENT } from "../tokens.js";
import { presentGroupCandidate, UserGroupCandidateRepository } from "./user-group-candidates.js";
import { evaluateUserGroup } from "./user-group-evaluator.js";
import {
  createUserGroupSchema,
  previewUserGroupSchema,
  updateUserGroupSchema,
  userGroupDefinitionSchema,
} from "./user-group.schemas.js";

const includeLatest = {
  evaluations: { orderBy: { evaluatedAt: "desc" as const }, take: 1 },
} satisfies Prisma.ApplicationUserGroupInclude;

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function present(row: {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly definitionJson: unknown;
  readonly definitionVersion: number;
  readonly refreshMinutes: number | null;
  readonly enabled: boolean;
  readonly lastEvaluatedAt: Date | null;
  readonly updatedAt: Date;
  readonly evaluations: readonly {
    readonly id: string;
    readonly memberCount: number;
    readonly evaluatedAt: Date;
  }[];
}) {
  const latest = row.evaluations[0];
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    definition: row.definitionJson,
    definition_version: row.definitionVersion,
    refresh_minutes: row.refreshMinutes,
    enabled: row.enabled,
    member_count: latest?.memberCount ?? 0,
    latest_evaluation_id: latest?.id ?? null,
    evaluated_at: latest?.evaluatedAt.toISOString() ?? null,
    last_evaluated_at: row.lastEvaluatedAt?.toISOString() ?? null,
    updated_at: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class ApplicationUserGroupService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(AuditContextService) private readonly context: AuditContextService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(UserGroupCandidateRepository)
    private readonly candidates: UserGroupCandidateRepository,
  ) {}

  private applicationId(): string {
    const id = this.context.current().applicationId;
    if (id === undefined) throw new ForbiddenException("An application context is required");
    return id;
  }

  private async requireGroup(id: string) {
    const row = await this.database.applicationUserGroup.findFirst({
      where: { applicationId: this.applicationId(), id },
      include: includeLatest,
    });
    if (row === null) throw new NotFoundException("User group not found");
    return row;
  }

  async list() {
    const rows = await this.database.applicationUserGroup.findMany({
      where: { applicationId: this.applicationId() },
      include: includeLatest,
      orderBy: [{ enabled: "desc" }, { name: "asc" }],
    });
    return { user_groups: rows.map(present) };
  }

  async get(id: string) {
    return present(await this.requireGroup(id));
  }

  async create(input: unknown) {
    const parsed = createUserGroupSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid user group");
    const applicationId = this.applicationId();
    try {
      const row = await this.database.applicationUserGroup.create({
        data: {
          applicationId,
          name: parsed.data.name,
          ...(parsed.data.description === undefined
            ? {}
            : { description: parsed.data.description }),
          definitionJson: json(parsed.data.definition),
          ...(parsed.data.refresh_minutes === undefined
            ? {}
            : { refreshMinutes: parsed.data.refresh_minutes }),
        },
        include: includeLatest,
      });
      await this.audit.record({
        action: "user_group.create",
        objectType: "application_user_group",
        objectId: row.id,
        after: { name: row.name, definition_version: row.definitionVersion },
        reason: "Created user group",
      });
      return present(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("This user group name already exists in the application");
      }
      throw error;
    }
  }

  async update(id: string, input: unknown) {
    const parsed = updateUserGroupSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid user group changes");
    const current = await this.requireGroup(id);
    const value = parsed.data;
    const row = await this.database.applicationUserGroup.update({
      where: { id: current.id },
      data: {
        ...(value.name === undefined ? {} : { name: value.name }),
        ...(value.description === undefined ? {} : { description: value.description }),
        ...(value.definition === undefined
          ? {}
          : {
              definitionJson: json(value.definition),
              definitionVersion: { increment: 1 },
              lastEvaluatedAt: null,
            }),
        ...(value.refresh_minutes === undefined ? {} : { refreshMinutes: value.refresh_minutes }),
        ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
      },
      include: includeLatest,
    });
    return present(row);
  }

  async preview(input: unknown) {
    const parsed = previewUserGroupSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid user group preview");
    const candidates = await this.candidates.load(this.applicationId());
    const matches = evaluateUserGroup(parsed.data.definition, candidates);
    return {
      member_count: matches.length,
      sample_users: matches.slice(0, parsed.data.limit).map(presentGroupCandidate),
    };
  }

  async evaluate(id: string, now = new Date()) {
    const group = await this.requireGroup(id);
    if (!group.enabled) throw new BadRequestException("Enable the user group before refreshing it");
    const definition = userGroupDefinitionSchema.parse(group.definitionJson);
    const candidates = await this.candidates.load(this.applicationId());
    const matches = evaluateUserGroup(definition, candidates);
    const latestEvaluation = group.evaluations[0];
    const evaluatedAt =
      latestEvaluation !== undefined && latestEvaluation.evaluatedAt >= now
        ? new Date(latestEvaluation.evaluatedAt.getTime() + 1)
        : now;
    const evaluation = await this.database.$transaction(
      async (transaction) => {
        const previousMembers =
          latestEvaluation === undefined
            ? []
            : await transaction.applicationUserGroupMember.findMany({
                where: {
                  applicationId: group.applicationId,
                  groupId: group.id,
                  evaluationId: latestEvaluation.id,
                },
                select: { userId: true },
              });
        const created = await transaction.applicationUserGroupEvaluation.create({
          data: {
            applicationId: group.applicationId,
            groupId: group.id,
            definitionVersion: group.definitionVersion,
            memberCount: matches.length,
            evaluatedAt,
          },
        });
        if (matches.length > 0) {
          await transaction.applicationUserGroupMember.createMany({
            data: matches.map((user) => ({
              applicationId: group.applicationId,
              evaluationId: created.id,
              groupId: group.id,
              userId: user.id,
              matchedAt: evaluatedAt,
            })),
          });
        }
        await transaction.applicationUserGroup.update({
          where: { id: group.id },
          data: { lastEvaluatedAt: evaluatedAt },
        });
        const quotaPolicy = await transaction.aiuQuotaPolicy.findFirst({
          where: {
            applicationId: group.applicationId,
            scope: AiuQuotaPolicyScope.USER_GROUP,
            userGroupId: group.id,
            enabled: true,
          },
          select: { id: true },
        });
        if (quotaPolicy !== null) {
          const application = await transaction.application.findUniqueOrThrow({
            where: { id: group.applicationId },
            select: { timezone: true },
          });
          const affected = new Set([
            ...previousMembers.map((member) => member.userId),
            ...matches.map((user) => user.id),
          ]);
          for (const userId of [...affected].sort()) {
            await materializeEffectiveAiuQuotaPolicy(
              transaction as unknown as AiuQuotaPolicyDatabase,
              {
                applicationId: group.applicationId,
                userId,
                reason: "Updated AIU quota after refreshing the user group",
                window: (policy) =>
                  policy.periodType === QuotaPeriodType.FIXED_WINDOW
                    ? { start: policy.startsAt!, end: policy.endsAt! }
                    : aiuQuotaPeriodWindow(policy.periodType, application.timezone, evaluatedAt),
              },
            );
          }
        }
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return {
      evaluation_id: evaluation.id,
      definition_version: group.definitionVersion,
      member_count: matches.length,
      evaluated_at: evaluatedAt.toISOString(),
      sample_users: matches.slice(0, 20).map(presentGroupCandidate),
    };
  }

  async members(id: string, evaluationId?: string) {
    const group = await this.requireGroup(id);
    const evaluation =
      evaluationId === undefined
        ? group.evaluations[0]
        : await this.database.applicationUserGroupEvaluation.findFirst({
            where: { applicationId: group.applicationId, groupId: group.id, id: evaluationId },
          });
    if (evaluation === undefined || evaluation === null) {
      return { evaluation_id: null, evaluated_at: null, members: [] };
    }
    const rows = await this.database.applicationUserGroupMember.findMany({
      where: { applicationId: group.applicationId, groupId: group.id, evaluationId: evaluation.id },
      include: { user: { include: { quota: true } } },
      orderBy: { user: { externalId: "asc" } },
      take: 10_000,
    });
    return {
      evaluation_id: evaluation.id,
      evaluated_at: evaluation.evaluatedAt.toISOString(),
      members: rows.map((row) => ({
        id: row.user.id,
        user_id: row.user.externalId,
        display_user: row.user.name,
        status: row.user.status.toLowerCase(),
        last_seen_at: row.user.lastSeenAt.toISOString(),
      })),
    };
  }
}

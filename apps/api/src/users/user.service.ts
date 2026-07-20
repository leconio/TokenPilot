import { randomUUID } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import {
  ApplicationUserStatus,
  PropertyScope,
  PropertyStatus,
  Prisma,
  type DatabaseClient,
} from "@tokenpilot/db";
import { isRealUtcDateTime } from "@tokenpilot/contracts";

import { AuditContextService } from "../audit-context.js";
import { AuditService } from "../audit.service.js";
import { DATABASE_CLIENT } from "../tokens.js";
import { RuntimeAccessSnapshotService } from "../runtime-configuration/runtime-access-snapshot.service.js";
import {
  createUserSchema,
  listUsersSchema,
  updateUserSchema,
  userAnalyticsRangeSchema,
} from "./user.schemas.js";
import { ApplicationUserMetricsRepository } from "./user-metrics.repository.js";
import { aiuToMicros, presentApplicationUser } from "./user-presentation.js";
import { enqueueApplicationUserProfile } from "./user-profile-outbox.js";
import { ApplicationUserQuotaService } from "./user-quota.service.js";

@Injectable()
export class ApplicationUserService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(AuditContextService) private readonly context: AuditContextService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ApplicationUserMetricsRepository)
    private readonly metrics: ApplicationUserMetricsRepository,
    @Inject(RuntimeAccessSnapshotService)
    private readonly accessSnapshots: RuntimeAccessSnapshotService,
    @Inject(ApplicationUserQuotaService)
    private readonly quotas: ApplicationUserQuotaService,
  ) {}

  private applicationId(): string {
    const id = this.context.current().applicationId;
    if (id === undefined) throw new ForbiddenException("An application context is required");
    return id;
  }

  private async requireUser(id: string, database: DatabaseClient = this.database) {
    const row = await database.applicationUser.findFirst({
      where: { applicationId: this.applicationId(), id },
      include: { quota: true },
    });
    if (row === null) throw new NotFoundException("User not found");
    return row;
  }

  async list(input: unknown) {
    const parsed = listUsersSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid user filters");
    const query = parsed.data;
    const applicationId = this.applicationId();
    const groupUserIds =
      query.group_id === undefined
        ? undefined
        : await this.currentGroupMembers(applicationId, query.group_id);
    const property =
      query.property_key === undefined
        ? undefined
        : await this.searchableUserProperty(
            applicationId,
            query.property_key,
            query.property_value!,
          );
    const search = await this.metrics.search(applicationId, {
      page: query.page,
      limit: query.limit,
      ...(query.search === undefined ? {} : { search: query.search }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.tag === undefined ? {} : { tag: query.tag }),
      ...(groupUserIds === undefined ? {} : { externalUserIds: groupUserIds }),
      ...(query.min_calls === undefined ? {} : { minimumCalls: query.min_calls }),
      ...(query.min_tokens === undefined ? {} : { minimumTokens: query.min_tokens }),
      ...(query.min_aiu === undefined ? {} : { minimumAiuMicros: aiuToMicros(query.min_aiu) }),
      ...(property === undefined ? {} : { property }),
    });
    const rows = await this.database.applicationUser.findMany({
      where: { applicationId, id: { in: search.rows.map((row) => row.id) } },
      include: { quota: true },
    });
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    return {
      users: search.rows.flatMap((result) => {
        const row = rowsById.get(result.id);
        return row === undefined ? [] : [presentApplicationUser(row, result.metrics)];
      }),
      page: query.page,
      page_size: query.limit,
      total: search.total,
    };
  }

  private async searchableUserProperty(applicationId: string, key: string, value: string) {
    const definition = await this.database.propertyDefinition.findFirst({
      where: {
        applicationId,
        key,
        scope: PropertyScope.USER,
        status: PropertyStatus.ACTIVE,
        searchable: true,
        sensitive: false,
      },
      select: { key: true, dataType: true },
    });
    if (definition === null) {
      throw new BadRequestException(`Field ${key} is not available for user search`);
    }
    if (definition.dataType === "NUMBER" && !Number.isFinite(Number(value))) {
      throw new BadRequestException(`The filter value does not match ${key}`);
    }
    if (definition.dataType === "BOOLEAN" && value !== "true" && value !== "false") {
      throw new BadRequestException(`The filter value does not match ${key}`);
    }
    if (definition.dataType === "DATETIME" && !isRealUtcDateTime(value)) {
      throw new BadRequestException(`The filter value does not match ${key}`);
    }
    return { ...definition, value };
  }

  async summary() {
    const applicationId = this.applicationId();
    const [totalUsers, blockedUsers, quota] = await Promise.all([
      this.database.applicationUser.count({ where: { applicationId } }),
      this.database.applicationUser.count({
        where: { applicationId, status: ApplicationUserStatus.BLOCKED },
      }),
      this.database.userAiuQuota.aggregate({
        where: { applicationId, enabled: true },
        _sum: {
          limitAiuMicros: true,
          consumedAiuMicros: true,
          reservedAiuMicros: true,
        },
      }),
    ]);
    const limit = quota._sum.limitAiuMicros ?? 0n;
    const used = quota._sum.consumedAiuMicros ?? 0n;
    const reserved = quota._sum.reservedAiuMicros ?? 0n;
    return {
      total_users: totalUsers,
      blocked_users: blockedUsers,
      limit_aiu_micros: limit.toString(),
      used_aiu_micros: used.toString(),
      reserved_aiu_micros: reserved.toString(),
      remaining_aiu_micros: (limit - used - reserved).toString(),
    };
  }

  private async currentGroupMembers(applicationId: string, groupId: string): Promise<string[]> {
    const group = await this.database.applicationUserGroup.findFirst({
      where: { applicationId, id: groupId, enabled: true },
      select: {
        definitionVersion: true,
        evaluations: {
          orderBy: { evaluatedAt: "desc" },
          take: 1,
          select: {
            definitionVersion: true,
            members: { select: { user: { select: { externalId: true } } } },
          },
        },
      },
    });
    if (group === null) throw new BadRequestException("The selected user group is not available");
    const evaluation = group.evaluations[0];
    if (evaluation === undefined || evaluation.definitionVersion !== group.definitionVersion) {
      throw new BadRequestException("Refresh the selected user group before filtering users");
    }
    return evaluation.members.map((member) => member.user.externalId);
  }

  async create(input: unknown) {
    const parsed = createUserSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid user");
    const value = parsed.data;
    try {
      const applicationId = this.applicationId();
      const row = await this.database.$transaction(async (transaction) => {
        const created = await transaction.applicationUser.create({
          data: {
            applicationId,
            externalId: value.user_id,
            ...(value.display_user === undefined ? {} : { name: value.display_user }),
            tags: [...new Set(value.tags)],
            propertiesJson: value.properties,
          },
          include: { quota: true },
        });
        await enqueueApplicationUserProfile(
          transaction,
          created,
          `user-profile:create:${created.id}:${randomUUID()}`,
        );
        await this.audit.record(
          {
            action: "user.create",
            objectType: "application_user",
            objectId: created.id,
            after: { user_id: created.externalId, display_user: created.name },
            reason: "Created application user",
          },
          transaction,
        );
        return created;
      });
      return presentApplicationUser(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("This user ID already exists in the application");
      }
      throw error;
    }
  }

  async get(id: string) {
    const row = await this.requireUser(id);
    const metrics = await this.metrics.load(this.applicationId(), [row.externalId]);
    return presentApplicationUser(row, metrics.get(row.externalId));
  }

  async analytics(id: string, input: unknown, now = new Date()) {
    const parsed = userAnalyticsRangeSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid user analytics range");
    const to = parsed.data.to === undefined ? now : new Date(parsed.data.to);
    const from =
      parsed.data.from === undefined
        ? new Date(to.getTime() - 30 * 86_400_000)
        : new Date(parsed.data.from);
    if (from >= to || to.getTime() - from.getTime() > 366 * 86_400_000) {
      throw new BadRequestException("User analytics range must be between one moment and 366 days");
    }
    const user = await this.requireUser(id);
    const applicationId = this.applicationId();
    const [analytics, operations] = await Promise.all([
      this.metrics.detail(applicationId, user.externalId, from, to),
      this.database.auditLog.findMany({
        where: { applicationId, objectType: "application_user", objectId: user.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 100,
        select: {
          id: true,
          action: true,
          actorId: true,
          reason: true,
          createdAt: true,
        },
      }),
    ]);
    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      ...analytics,
      operations: operations.map((operation) => ({
        id: operation.id,
        action: operation.action,
        actor: operation.actorId,
        reason: operation.reason,
        created_at: operation.createdAt.toISOString(),
      })),
    };
  }

  async update(id: string, input: unknown) {
    const parsed = updateUserSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid user changes");
    const current = await this.requireUser(id);
    const value = parsed.data;
    const accessChanged =
      value.blocked !== undefined &&
      (value.blocked
        ? current.status !== ApplicationUserStatus.BLOCKED
        : current.status !== ApplicationUserStatus.ACTIVE);
    const row = await this.database.$transaction(async (transaction) => {
      const changed = await transaction.applicationUser.update({
        where: { id: current.id },
        data: {
          ...(value.display_user === undefined ? {} : { name: value.display_user }),
          ...(value.tags === undefined ? {} : { tags: [...new Set(value.tags)] }),
          ...(value.blocked === undefined
            ? {}
            : value.blocked
              ? {
                  status: ApplicationUserStatus.BLOCKED,
                  blockedReason: value.reason ?? "Blocked by administrator",
                }
              : { status: ApplicationUserStatus.ACTIVE, blockedReason: null }),
        },
        include: { quota: true },
      });
      await enqueueApplicationUserProfile(
        transaction,
        changed,
        `user-profile:update:${changed.id}:${randomUUID()}`,
      );
      if (accessChanged) {
        await this.accessSnapshots.publishWithin(transaction, {
          applicationId: current.applicationId,
          actorId: this.context.current().actorId,
          reason: value.reason ?? (value.blocked ? "Stopped user access" : "Restored user access"),
        });
      }
      await this.audit.record(
        {
          action: value.blocked === undefined ? "user.update" : "user.access.update",
          objectType: "application_user",
          objectId: changed.id,
          before: { status: current.status, name: current.name, tags: current.tags },
          after: { status: changed.status, name: changed.name, tags: changed.tags },
          reason: value.reason ?? "Updated user",
        },
        transaction,
      );
      return changed;
    });
    return presentApplicationUser(row);
  }

  async saveQuota(id: string, input: unknown) {
    await this.quotas.save(id, input);
    return this.get(id);
  }

  async resetQuota(id: string, input: unknown) {
    await this.quotas.reset(id, input);
    return this.get(id);
  }

  async ledger(id: string, limit = 100) {
    return this.quotas.ledger(id, limit);
  }
}

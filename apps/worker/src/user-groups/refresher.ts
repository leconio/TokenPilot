import { randomUUID } from "node:crypto";

import type { ClickHouseClient } from "@tokenpilot/clickhouse";
import {
  AiuQuotaPolicyScope,
  aiuQuotaPeriodWindow,
  materializeEffectiveAiuQuotaPolicy,
  Prisma,
  QuotaPeriodType,
  type AiuQuotaPolicyDatabase,
  type DatabaseClient,
} from "@tokenpilot/db";
import { evaluateUserGroup, userGroupDefinitionSchema } from "@tokenpilot/user-segmentation";
import type { Redis } from "ioredis";

import type { CurrentMaintenanceLogger } from "../maintenance/current-maintenance.js";
import { UserGroupCandidateLoader } from "./candidate-loader.js";

const LOCK_TTL_MS = 5 * 60_000;

export interface UserGroupRefreshOutcome {
  readonly due: number;
  readonly refreshed: number;
  readonly failed: number;
}

export class UserGroupRefresher {
  private readonly candidates: UserGroupCandidateLoader;

  constructor(
    private readonly database: DatabaseClient,
    clickhouse: ClickHouseClient,
    private readonly redis: Redis,
    private readonly logger: CurrentMaintenanceLogger,
  ) {
    this.candidates = new UserGroupCandidateLoader(database, clickhouse);
  }

  async refreshDue(limit: number, now = new Date()): Promise<UserGroupRefreshOutcome> {
    const rows = await this.database.applicationUserGroup.findMany({
      where: { enabled: true, refreshMinutes: { not: null } },
      orderBy: [{ lastEvaluatedAt: "asc" }, { id: "asc" }],
      take: Math.max(limit * 4, limit),
    });
    const due = rows
      .filter(
        (group) =>
          group.refreshMinutes !== null &&
          (group.lastEvaluatedAt === null ||
            group.lastEvaluatedAt.getTime() + group.refreshMinutes * 60_000 <= now.getTime()),
      )
      .slice(0, limit);
    let refreshed = 0;
    let failed = 0;
    for (const group of due) {
      const key = `app:${group.applicationId}:user-group:${group.id}:refresh`;
      const token = randomUUID();
      if ((await this.redis.set(key, token, "PX", LOCK_TTL_MS, "NX")) !== "OK") continue;
      try {
        await this.refresh(group, now);
        refreshed += 1;
      } catch (error) {
        failed += 1;
        this.logger.error("user_group.refresh.failed", error, {
          application_id: group.applicationId,
          user_group_id: group.id,
        });
      } finally {
        await this.redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          key,
          token,
        );
      }
    }
    if (refreshed > 0 || failed > 0) {
      this.logger.info("user_group.refresh.completed", {
        due: due.length,
        refreshed,
        failed,
      });
    }
    return { due: due.length, refreshed, failed };
  }

  private async refresh(
    group: {
      readonly id: string;
      readonly applicationId: string;
      readonly definitionJson: Prisma.JsonValue;
      readonly definitionVersion: number;
    },
    now: Date,
  ): Promise<void> {
    const definition = userGroupDefinitionSchema.parse(group.definitionJson);
    const candidates = await this.candidates.load(group.applicationId);
    const matches = evaluateUserGroup(definition, candidates);
    await this.database.$transaction(
      async (transaction) => {
        const current = await transaction.applicationUserGroup.findFirst({
          where: { id: group.id, applicationId: group.applicationId, enabled: true },
          select: { definitionVersion: true },
        });
        if (current === null || current.definitionVersion !== group.definitionVersion) {
          throw Object.assign(new Error("User group changed during refresh"), { code: "P2034" });
        }
        const previousEvaluation = await transaction.applicationUserGroupEvaluation.findFirst({
          where: { applicationId: group.applicationId, groupId: group.id },
          orderBy: { evaluatedAt: "desc" },
          select: { id: true, evaluatedAt: true },
        });
        const previousMembers =
          previousEvaluation === null
            ? []
            : await transaction.applicationUserGroupMember.findMany({
                where: {
                  applicationId: group.applicationId,
                  groupId: group.id,
                  evaluationId: previousEvaluation.id,
                },
                select: { userId: true },
              });
        const evaluatedAt =
          previousEvaluation !== null && previousEvaluation.evaluatedAt >= now
            ? new Date(previousEvaluation.evaluatedAt.getTime() + 1)
            : now;
        const evaluation = await transaction.applicationUserGroupEvaluation.create({
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
              evaluationId: evaluation.id,
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
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}

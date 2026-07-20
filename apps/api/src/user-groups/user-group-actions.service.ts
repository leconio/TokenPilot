import { randomUUID } from "node:crypto";

import { BadRequestException, ForbiddenException, Inject, Injectable } from "@nestjs/common";

import {
  AiuLedgerEntryType,
  AiuReservationStatus,
  ApplicationUserStatus,
  Prisma,
  QuotaPeriodType,
  type DatabaseClient,
} from "@tokenpilot/db";

import { AuditContextService } from "../audit-context.js";
import { AuditService } from "../audit.service.js";
import { DATABASE_CLIENT } from "../tokens.js";
import { RuntimeAccessSnapshotService } from "../runtime-configuration/runtime-access-snapshot.service.js";
import { enqueueApplicationUserProfiles } from "../users/user-profile-outbox.js";
import { userGroupBulkActionSchema } from "./user-group.schemas.js";

function periodEnd(type: QuotaPeriodType, start: Date): Date | null {
  if (type === QuotaPeriodType.LIFETIME) return null;
  const end = new Date(start);
  if (type === QuotaPeriodType.CALENDAR_DAY) end.setUTCDate(end.getUTCDate() + 1);
  if (type === QuotaPeriodType.CALENDAR_WEEK) end.setUTCDate(end.getUTCDate() + 7);
  if (type === QuotaPeriodType.CALENDAR_MONTH) end.setUTCMonth(end.getUTCMonth() + 1);
  return end;
}

@Injectable()
export class ApplicationUserGroupActionsService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(AuditContextService) private readonly context: AuditContextService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RuntimeAccessSnapshotService)
    private readonly accessSnapshots: RuntimeAccessSnapshotService,
  ) {}

  private application() {
    const current = this.context.current();
    if (current.applicationId === undefined) {
      throw new ForbiddenException("An application context is required");
    }
    return { id: current.applicationId, actorId: current.actorId };
  }

  async run(groupId: string, input: unknown, now = new Date()) {
    const parsed = userGroupBulkActionSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid user group action");
    const application = this.application();
    const group = await this.database.applicationUserGroup.findFirst({
      where: { applicationId: application.id, id: groupId },
      include: {
        evaluations: {
          orderBy: { evaluatedAt: "desc" },
          take: 1,
          include: {
            members: {
              include: { user: { include: { quota: true } } },
              orderBy: { userId: "asc" },
            },
          },
        },
      },
    });
    if (group === null) throw new BadRequestException("User group not found");
    const evaluation = group.evaluations[0];
    if (evaluation === undefined || evaluation.definitionVersion !== group.definitionVersion) {
      throw new BadRequestException("Refresh the user group before applying a group action");
    }
    const memberIds = evaluation.members.map((member) => member.userId);
    const outcome =
      parsed.data.action === "quota_reset"
        ? await this.resetQuotas(
            application.id,
            group.id,
            evaluation,
            parsed.data.reason,
            application.actorId,
            now,
          )
        : await this.setBlocked(
            application.id,
            group.id,
            evaluation.id,
            memberIds,
            parsed.data.action === "block",
            parsed.data.reason,
            application.actorId,
            now,
          );
    await this.audit.record({
      action: `user_group.${parsed.data.action}`,
      objectType: "application_user_group",
      objectId: group.id,
      after: {
        evaluation_id: evaluation.id,
        target_count: outcome.target_count,
        success_count: outcome.success_count,
        failure_count: outcome.failure_count,
      },
      reason: parsed.data.reason,
    });
    return outcome;
  }

  private async setBlocked(
    applicationId: string,
    groupId: string,
    evaluationId: string,
    userIds: readonly string[],
    blocked: boolean,
    reason: string,
    actorId: string,
    now: Date,
  ) {
    return this.database.$transaction(async (transaction) => {
      const changed =
        userIds.length === 0
          ? { count: 0 }
          : await transaction.applicationUser.updateMany({
              where: { applicationId, id: { in: [...userIds] } },
              data: blocked
                ? { status: ApplicationUserStatus.BLOCKED, blockedReason: reason }
                : { status: ApplicationUserStatus.ACTIVE, blockedReason: null },
            });
      const failureCount = userIds.length - changed.count;
      const record = await transaction.applicationUserGroupBulkAction.create({
        data: {
          applicationId,
          groupId,
          evaluationId,
          action: blocked ? "block" : "unblock",
          reason,
          actorId,
          targetCount: userIds.length,
          successCount: changed.count,
          failureCount,
          resultJson: { completed_at: now.toISOString(), failed_user_ids: [] },
        },
      });
      const changedUsers =
        changed.count === 0
          ? []
          : await transaction.applicationUser.findMany({
              where: { applicationId, id: { in: [...userIds] } },
              orderBy: { id: "asc" },
            });
      await enqueueApplicationUserProfiles(
        transaction,
        applicationId,
        changedUsers,
        (user) => `user-profile:group-access:${record.id}:${user.id}`,
      );
      await this.accessSnapshots.publishWithin(transaction, {
        applicationId,
        actorId,
        reason,
        now,
      });
      return {
        action_id: record.id,
        evaluation_id: evaluationId,
        target_count: userIds.length,
        success_count: changed.count,
        failure_count: failureCount,
      };
    });
  }

  private async resetQuotas(
    applicationId: string,
    groupId: string,
    evaluation: {
      readonly id: string;
      readonly members: readonly {
        readonly userId: string;
        readonly user: {
          readonly quota: {
            readonly id: string;
            readonly periodType: QuotaPeriodType;
            readonly consumedAiuMicros: bigint;
            readonly reservedAiuMicros: bigint;
            readonly limitAiuMicros: bigint;
            readonly lockVersion: number;
          } | null;
        };
      }[];
    },
    reason: string,
    actorId: string,
    now: Date,
  ) {
    return this.database.$transaction(
      async (transaction) => {
        const failed: string[] = [];
        let succeeded = 0;
        for (const member of evaluation.members) {
          const quota = member.user.quota;
          if (quota === null) {
            failed.push(member.userId);
            continue;
          }
          await transaction.userAiuReservation.updateMany({
            where: {
              applicationId,
              userId: member.userId,
              status: AiuReservationStatus.RESERVED,
            },
            data: {
              status: AiuReservationStatus.RELEASED,
              releasedAt: now,
              lockVersion: { increment: 1 },
            },
          });
          const changed = await transaction.userAiuQuota.updateMany({
            where: { applicationId, id: quota.id, lockVersion: quota.lockVersion },
            data: {
              consumedAiuMicros: 0,
              reservedAiuMicros: 0,
              periodStart: now,
              periodEnd: periodEnd(quota.periodType, now),
              lockVersion: { increment: 1 },
            },
          });
          if (changed.count !== 1) {
            failed.push(member.userId);
            continue;
          }
          await transaction.userAiuLedgerEntry.create({
            data: {
              applicationId,
              userId: member.userId,
              quotaId: quota.id,
              entryType: AiuLedgerEntryType.ADJUSTMENT,
              consumedDeltaMicros: -quota.consumedAiuMicros,
              reservedDeltaMicros: -quota.reservedAiuMicros,
              consumedAfterMicros: 0,
              reservedAfterMicros: 0,
              limitAfterMicros: quota.limitAiuMicros,
              idempotencyKey: `group-quota-reset:${evaluation.id}:${member.userId}:${randomUUID()}`,
              reason,
            },
          });
          succeeded += 1;
        }
        const record = await transaction.applicationUserGroupBulkAction.create({
          data: {
            applicationId,
            groupId,
            evaluationId: evaluation.id,
            action: "quota_reset",
            reason,
            actorId,
            targetCount: evaluation.members.length,
            successCount: succeeded,
            failureCount: failed.length,
            resultJson: { completed_at: now.toISOString(), failed_user_ids: failed },
          },
        });
        return {
          action_id: record.id,
          evaluation_id: evaluation.id,
          target_count: evaluation.members.length,
          success_count: succeeded,
          failure_count: failed.length,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}

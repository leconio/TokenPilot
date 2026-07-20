import { Prisma, ReconciliationRunStatus, type DatabaseClient } from "@tokenpilot/db";
import type { FreshClickHouseRebuildPlan, ReplayPlan } from "@tokenpilot/reconciliation-engine";

export interface ClickHouseRebuildExecutor {
  execute(
    plan: FreshClickHouseRebuildPlan,
    context: { readonly runId: string; readonly reason: string },
  ): Promise<Readonly<Record<string, unknown>>>;
}

interface OperationEnvelope {
  readonly operation: "replay" | "rebuild";
  readonly plan: unknown;
  readonly source_diff_id?: string | null;
  readonly reason: string;
}

function envelope(value: unknown): OperationEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Reconciliation operation payload is invalid");
  }
  const candidate = value as Partial<OperationEnvelope>;
  if (
    (candidate.operation !== "replay" && candidate.operation !== "rebuild") ||
    candidate.plan === undefined ||
    typeof candidate.reason !== "string" ||
    candidate.reason.trim().length < 5
  ) {
    throw new TypeError("Reconciliation operation payload is incomplete");
  }
  return candidate as OperationEnvelope;
}

function replayPlan(value: unknown): ReplayPlan {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Replay plan is invalid");
  }
  const plan = value as ReplayPlan;
  if (plan.dryRun || typeof plan.replayType !== "string") {
    throw new TypeError("Queued replay plan must be committed");
  }
  return plan;
}

const FRESH_REBUILD_STEPS = [
  "clear_isolated_database",
  "create_current_schema",
  "replay_postgresql_outbox",
  "verify_current_projection",
] as const;

function rebuildPlan(value: unknown): FreshClickHouseRebuildPlan {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("ClickHouse rebuild plan is invalid");
  }
  const plan = value as FreshClickHouseRebuildPlan;
  if (
    typeof plan.rebuildId !== "string" ||
    typeof plan.database !== "string" ||
    !Array.isArray(plan.steps) ||
    plan.steps.length !== FRESH_REBUILD_STEPS.length ||
    plan.steps.some((step, index) => step !== FRESH_REBUILD_STEPS[index])
  ) {
    throw new TypeError("ClickHouse rebuild plan is incomplete");
  }
  return plan;
}

/** Executes auditable recovery operations only from PostgreSQL authority. */
export class PrismaReconciliationOperationExecutor {
  constructor(
    private readonly database: DatabaseClient,
    private readonly clickhouseRebuild: ClickHouseRebuildExecutor,
  ) {}

  async executeReplay(runId: string): Promise<Readonly<Record<string, unknown>> | null> {
    const claimed = await this.claim(runId, "replay");
    if (claimed === null) return null;
    try {
      const plan = replayPlan(claimed.operation.plan);
      const result = await this.applyReplay(runId, claimed.applicationId, plan);
      await this.complete(runId);
      return result;
    } catch (error) {
      await this.fail(runId, error);
      throw error;
    }
  }

  async executeRebuild(runId: string): Promise<Readonly<Record<string, unknown>> | null> {
    const claimed = await this.claim(runId, "rebuild");
    if (claimed === null) return null;
    try {
      const result = await this.clickhouseRebuild.execute(rebuildPlan(claimed.operation.plan), {
        runId,
        reason: claimed.operation.reason,
      });
      await this.complete(runId);
      return result;
    } catch (error) {
      await this.fail(runId, error);
      throw error;
    }
  }

  private async claim(
    runId: string,
    expected: OperationEnvelope["operation"],
  ): Promise<{ readonly applicationId: string; readonly operation: OperationEnvelope } | null> {
    return this.database.$transaction(async (transaction) => {
      const changed = await transaction.reconciliationRun.updateMany({
        where: {
          id: runId,
          status: { in: [ReconciliationRunStatus.QUEUED, ReconciliationRunStatus.FAILED] },
        },
        data: { status: ReconciliationRunStatus.RUNNING, startedAt: new Date(), error: null },
      });
      if (changed.count !== 1) return null;
      const run = await transaction.reconciliationRun.findUniqueOrThrow({
        where: { id: runId },
        select: { applicationId: true, scopeJson: true },
      });
      const operation = envelope(run.scopeJson);
      if (operation.operation !== expected) {
        throw new TypeError(`Expected ${expected} operation, received ${operation.operation}`);
      }
      return { applicationId: run.applicationId, operation };
    });
  }

  private async applyReplay(
    runId: string,
    applicationId: string,
    plan: ReplayPlan,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (plan.replayType === "reproject_to_clickhouse") {
      const outboxRecords = await this.resetOutbox(runId, applicationId, plan);
      return { replay_type: plan.replayType, outbox_records_requeued: outboxRecords };
    }
    if (plan.replayType === "rerun_provider_cost" || plan.replayType === "rerun_aiu_observe") {
      const inboxRecords = await this.resetInbox(runId, applicationId, plan);
      return { replay_type: plan.replayType, inbox_records_requeued: inboxRecords };
    }
    const buckets = await this.rebuildQuota(applicationId);
    return { replay_type: plan.replayType, quota_buckets_rebuilt: buckets };
  }

  private resetOutbox(runId: string, applicationId: string, plan: ReplayPlan): Promise<number> {
    return this.database.$executeRaw(Prisma.sql`
      INSERT INTO pipeline_outbox (
        application_id, aggregate_type, aggregate_id, event_type, payload_json, status,
        idempotency_key, replay_of_outbox_id, attempt_count, available_at, updated_at
      )
      SELECT outbox.application_id, outbox.aggregate_type, outbox.aggregate_id, outbox.event_type,
             outbox.payload_json, 'pending',
             ${`reconciliation:${runId}:outbox:`} || outbox.id::text,
             COALESCE(outbox.replay_of_outbox_id, outbox.id),
             0, statement_timestamp(), statement_timestamp()
      FROM pipeline_outbox AS outbox
      WHERE outbox.application_id = ${applicationId}::uuid
      AND outbox.status IN ('sent', 'dead_letter')
      AND outbox.idempotency_key NOT LIKE 'reconciliation:%'
      AND outbox.event_type IN (
        'usage_events_raw', 'usage_lines', 'provider_cost.provisional',
        'provider_cost.official_delta', 'provider_cost.adjustment',
        'provider_cost.unpriced', 'aiu.provisional', 'aiu.official_delta', 'aiu.decision',
        'application_user.profile'
      )
      AND (
        (
          outbox.event_type = 'application_user.profile'
          AND (outbox.payload_json->>'profile_updated_at')::timestamptz >= ${new Date(plan.rangeStart)}
          AND (outbox.payload_json->>'profile_updated_at')::timestamptz < ${new Date(plan.rangeEnd)}
        )
        OR (
          outbox.event_type <> 'application_user.profile'
          AND (
            outbox.aggregate_id IN (
              SELECT registry.event_id FROM usage_event_registry AS registry
              WHERE registry.application_id = ${applicationId}::uuid
                AND registry.event_time >= ${new Date(plan.rangeStart)}
                AND registry.event_time < ${new Date(plan.rangeEnd)}
            )
            OR outbox.payload_json->>'event_id' IN (
              SELECT registry.event_id FROM usage_event_registry AS registry
              WHERE registry.application_id = ${applicationId}::uuid
                AND registry.event_time >= ${new Date(plan.rangeStart)}
                AND registry.event_time < ${new Date(plan.rangeEnd)}
            )
          )
        )
      )
      ON CONFLICT (application_id, idempotency_key) DO NOTHING
    `);
  }

  private resetInbox(runId: string, applicationId: string, plan: ReplayPlan): Promise<number> {
    return this.database.$executeRaw(Prisma.sql`
      UPDATE ingestion_inbox AS inbox
      SET status = 'pending', stage = 'received', available_at = statement_timestamp(),
          attempt_count = 0, next_retry_at = NULL, completed_at = NULL,
          lease_owner = NULL, lease_expires_at = NULL, last_error = NULL,
          payload_purge_after = NULL, payload_purged_at = NULL,
          replay_intent_json = jsonb_build_object(
            'authority', 'reconciliation',
            'run_id', ${runId},
            'replay_type', ${plan.replayType}
          ),
          updated_at = statement_timestamp()
      FROM usage_event_registry AS registry
      WHERE registry.event_id = inbox.event_id
        AND registry.application_id = inbox.application_id
        AND inbox.application_id = ${applicationId}::uuid
        AND inbox.payload_json IS NOT NULL
        AND inbox.status IN ('pending', 'failed', 'completed', 'dead_letter')
        AND registry.event_time >= ${new Date(plan.rangeStart)}
        AND registry.event_time < ${new Date(plan.rangeEnd)}
    `);
  }

  private rebuildQuota(applicationId: string): Promise<number> {
    return this.database.$executeRaw(Prisma.sql`
      WITH latest AS (
        SELECT DISTINCT ON (entry.quota_id)
          entry.quota_id,
          entry.consumed_after_micros,
          entry.reserved_after_micros,
          entry.limit_after_micros
        FROM user_aiu_ledger_entries AS entry
        WHERE entry.application_id = ${applicationId}::uuid
        ORDER BY entry.quota_id, entry.created_at DESC, entry.id DESC
      )
      UPDATE user_aiu_quotas AS quota
      SET consumed_aiu_micros = latest.consumed_after_micros,
          reserved_aiu_micros = latest.reserved_after_micros,
          limit_aiu_micros = latest.limit_after_micros,
          lock_version = quota.lock_version + 1,
          updated_at = statement_timestamp()
      FROM latest
      WHERE quota.id = latest.quota_id
        AND quota.application_id = ${applicationId}::uuid
    `);
  }

  private async complete(runId: string): Promise<void> {
    await this.database.reconciliationRun.update({
      where: { id: runId },
      data: {
        status: ReconciliationRunStatus.COMPLETED,
        finishedAt: new Date(),
        error: null,
      },
    });
  }

  private async fail(runId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown failure";
    await this.database.reconciliationRun.updateMany({
      where: { id: runId, status: ReconciliationRunStatus.RUNNING },
      data: {
        status: ReconciliationRunStatus.FAILED,
        finishedAt: new Date(),
        error: message.slice(0, 8_000),
      },
    });
  }
}

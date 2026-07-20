import { randomUUID } from "node:crypto";

import type {
  ClickHouseOutboxDeliveryResult,
  ClickHouseOutboxRecord,
} from "@tokenpilot/clickhouse";
import { ClickhouseSyncStatus, Prisma, type DatabaseClient } from "@tokenpilot/db";

import { RetryablePipelineError } from "./errors.js";
import type { OutboxLease } from "./types.js";

interface OutboxLeaseRow {
  readonly id: bigint;
  readonly application_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly payload_json: unknown;
  readonly idempotency_key: string;
  readonly replay_of_outbox_id: bigint | null;
  readonly attempt_count: number;
  readonly lease_owner: string;
  readonly lease_expires_at: Date;
  readonly created_at: Date;
}

export interface PrismaOutboxStoreOptions {
  readonly leaseDurationMs?: number;
  readonly workerId?: string;
  readonly pipelineName?: string;
}

export interface OutboxFailure {
  readonly code: string;
  readonly errorClass: string;
  readonly message: string;
  readonly retryable: boolean;
}

function mapLease(row: OutboxLeaseRow): OutboxLease {
  return {
    id: BigInt(row.id),
    applicationId: row.application_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload_json,
    idempotencyKey: row.idempotency_key,
    replayOfOutboxId: row.replay_of_outbox_id === null ? null : BigInt(row.replay_of_outbox_id),
    attemptCount: row.attempt_count,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: new Date(row.lease_expires_at),
    createdAt: new Date(row.created_at),
  };
}

export function outboxLeaseRecord(lease: OutboxLease): ClickHouseOutboxRecord {
  return {
    id: lease.id,
    aggregateType: lease.aggregateType,
    aggregateId: lease.aggregateId,
    eventType: lease.eventType,
    payload: lease.payload,
    idempotencyKey: lease.idempotencyKey,
    replayOfOutboxId: lease.replayOfOutboxId,
    createdAt: lease.createdAt,
  };
}

export class PrismaClickHouseOutboxStore {
  private readonly leaseDurationMs: number;
  private readonly workerId: string;
  private readonly pipelineName: string;

  constructor(
    private readonly database: DatabaseClient,
    options: PrismaOutboxStoreOptions = {},
  ) {
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.workerId = options.workerId ?? `clickhouse-outbox-${process.pid}`;
    this.pipelineName = options.pipelineName ?? "dual_store";
    if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs < 1_000) {
      throw new RangeError("Outbox lease duration must be at least one second");
    }
  }

  async leaseOutbox(eventTypes: readonly string[], limit: number): Promise<readonly OutboxLease[]> {
    if (eventTypes.length === 0) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Outbox lease batch size must be between 1 and 1000");
    }
    const acquisitionToken = `${this.workerId}:${randomUUID()}`;
    const rows = await this.database.$transaction((transaction) =>
      transaction.$queryRawUnsafe<OutboxLeaseRow[]>(
        `WITH candidates AS (
           SELECT o.id
           FROM pipeline_outbox AS o
           WHERE o.event_type = ANY($1::text[])
             AND (
               (o.status IN ('pending', 'failed')
                 AND o.available_at <= statement_timestamp()
                 AND COALESCE(o.next_retry_at, o.available_at) <= statement_timestamp())
               OR (o.status = 'leased' AND o.lease_expires_at <= statement_timestamp())
             )
           ORDER BY o.available_at ASC, o.id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE pipeline_outbox AS o
         SET status = 'leased',
             attempt_count = o.attempt_count + 1,
             lease_owner = $3 || ':' || o.id::text,
             lease_expires_at = statement_timestamp() + ($4 * INTERVAL '1 millisecond'),
             next_retry_at = NULL,
             last_error = NULL,
             updated_at = statement_timestamp()
         FROM candidates
         WHERE o.id = candidates.id
         RETURNING o.id, o.application_id, o.aggregate_type, o.aggregate_id, o.event_type, o.payload_json,
                   o.idempotency_key, o.replay_of_outbox_id, o.attempt_count, o.lease_owner,
                   o.lease_expires_at, o.created_at`,
        [...eventTypes],
        limit,
        acquisitionToken,
        this.leaseDurationMs,
      ),
    );
    return rows.map(mapLease);
  }

  /** Marks PG delivery and registry/sync watermarks only after CH rows and CH watermark succeeded. */
  async markDelivered(
    leases: readonly OutboxLease[],
    result: ClickHouseOutboxDeliveryResult,
  ): Promise<void> {
    const expectedIds = leases.map((lease) => lease.id);
    if (
      expectedIds.length === 0 ||
      result.outboxIds.length !== expectedIds.length ||
      expectedIds.some((id, index) => result.outboxIds[index] !== id) ||
      result.maxOutboxId !== expectedIds.at(-1)
    ) {
      throw new TypeError("ClickHouse delivery acknowledgement does not match the leased batch");
    }
    await this.database.$transaction(
      async (transaction) => {
        const deliveredAt = new Date();
        for (const lease of leases) {
          const changed = await transaction.$executeRawUnsafe(
            `UPDATE pipeline_outbox
             SET status = 'sent', sent_at = $3, next_retry_at = NULL,
                 last_error = NULL, updated_at = $3
             WHERE id = $1::bigint
               AND status = 'leased'
               AND lease_owner = $2
               AND lease_expires_at > statement_timestamp()`,
            lease.id,
            lease.leaseOwner,
            deliveredAt,
          );
          if (changed !== 1) throw this.leaseLost(lease);

          if (lease.eventType === "usage_events_raw") {
            await transaction.$executeRawUnsafe(
              `UPDATE usage_event_registry
               SET clickhouse_raw_synced_at = COALESCE(clickhouse_raw_synced_at, $2),
                   updated_at = statement_timestamp()
               WHERE event_id = $1
                 AND application_id = $3::uuid`,
              lease.aggregateId,
              deliveredAt,
              lease.applicationId,
            );
          }
        }
        // A batch can contain an official rating with a lower Outbox ID than
        // its raw usage event. Apply every raw-sync marker first so the
        // immediate PostgreSQL sync-order constraint remains true throughout
        // the transaction, not only at commit time.
        for (const lease of leases) {
          if (
            lease.eventType === "provider_cost.official_delta" ||
            lease.eventType === "provider_cost.adjustment" ||
            lease.eventType === "provider_cost.unpriced" ||
            lease.eventType === "aiu.official_delta" ||
            lease.eventType === "aiu.decision"
          ) {
            await transaction.$executeRawUnsafe(
              `UPDATE usage_event_registry AS registry
               SET clickhouse_official_synced_at = COALESCE(registry.clickhouse_official_synced_at, $2),
                   updated_at = statement_timestamp()
               FROM pipeline_outbox AS outbox
               WHERE outbox.id = $1::bigint
                 AND registry.application_id = outbox.application_id
                 AND registry.event_id = outbox.payload_json->>'event_id'`,
              lease.id,
              deliveredAt,
            );
          }
        }
        const lagSeconds = BigInt(
          Math.max(
            0,
            Math.floor(
              (deliveredAt.getTime() -
                (result.maxEventTime ?? leases.at(-1)?.createdAt ?? deliveredAt).getTime()) /
                1_000,
            ),
          ),
        );
        await transaction.$executeRawUnsafe(
          `INSERT INTO clickhouse_sync_state (
             pipeline_name, last_outbox_id, last_event_time, last_success_at,
             lag_seconds, status, last_error, updated_at
           ) VALUES (
             $1, $2::bigint, $3::timestamptz, $4::timestamptz,
             $5::bigint, 'healthy', NULL, statement_timestamp()
           )
           ON CONFLICT (pipeline_name) DO UPDATE SET
             last_outbox_id = CASE
               WHEN clickhouse_sync_state.last_outbox_id IS NULL
                 OR EXCLUDED.last_outbox_id >= clickhouse_sync_state.last_outbox_id
               THEN EXCLUDED.last_outbox_id
               ELSE clickhouse_sync_state.last_outbox_id
             END,
             last_event_time = CASE
               WHEN clickhouse_sync_state.last_outbox_id IS NULL
                 OR EXCLUDED.last_outbox_id >= clickhouse_sync_state.last_outbox_id
               THEN EXCLUDED.last_event_time
               ELSE clickhouse_sync_state.last_event_time
             END,
             last_success_at = GREATEST(
               clickhouse_sync_state.last_success_at,
               EXCLUDED.last_success_at
             ),
             lag_seconds = CASE
               WHEN clickhouse_sync_state.last_outbox_id IS NULL
                 OR EXCLUDED.last_outbox_id >= clickhouse_sync_state.last_outbox_id
               THEN EXCLUDED.lag_seconds
               ELSE clickhouse_sync_state.lag_seconds
             END,
             status = CASE
               WHEN clickhouse_sync_state.last_outbox_id IS NULL
                 OR EXCLUDED.last_outbox_id >= clickhouse_sync_state.last_outbox_id
               THEN EXCLUDED.status
               ELSE clickhouse_sync_state.status
             END,
             last_error = CASE
               WHEN clickhouse_sync_state.last_outbox_id IS NULL
                 OR EXCLUDED.last_outbox_id >= clickhouse_sync_state.last_outbox_id
               THEN NULL
               ELSE clickhouse_sync_state.last_error
             END,
             updated_at = statement_timestamp()`,
          this.pipelineName,
          result.maxOutboxId,
          result.maxEventTime,
          deliveredAt,
          lagSeconds,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async retry(lease: OutboxLease, failure: OutboxFailure, retryAt: Date): Promise<void> {
    const changed = await this.database.$executeRawUnsafe(
      `UPDATE pipeline_outbox
       SET status = 'failed', available_at = $3, next_retry_at = $3,
           last_error = $4, updated_at = statement_timestamp()
       WHERE id = $1::bigint
         AND status = 'leased'
         AND lease_owner = $2
         AND lease_expires_at > statement_timestamp()`,
      lease.id,
      lease.leaseOwner,
      retryAt,
      `${failure.code}: ${failure.message}`,
    );
    if (changed !== 1) throw this.leaseLost(lease);
    await this.markSyncFailure(failure);
  }

  async deadLetter(lease: OutboxLease, failure: OutboxFailure): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const changed = await transaction.$executeRawUnsafe(
        `UPDATE pipeline_outbox
         SET status = 'dead_letter', next_retry_at = NULL,
             last_error = $3, updated_at = statement_timestamp()
         WHERE id = $1::bigint
           AND status = 'leased'
           AND lease_owner = $2
           AND lease_expires_at > statement_timestamp()`,
        lease.id,
        lease.leaseOwner,
        `${failure.code}: ${failure.message}`,
      );
      if (changed !== 1) throw this.leaseLost(lease);
      await transaction.deadLetterEvent.create({
        data: {
          applicationId: lease.applicationId,
          outboxId: lease.id,
          stage: "OUTBOX_CREATED",
          errorCode: failure.code,
          errorClass: failure.errorClass,
          errorMessage: failure.message,
          detailsJson: {
            outbox_id: lease.id.toString(),
            event_type: lease.eventType,
            aggregate_type: lease.aggregateType,
            aggregate_id: lease.aggregateId,
          },
          attemptCount: lease.attemptCount,
        },
        select: { id: true },
      });
    });
    await this.markSyncFailure(failure, true);
  }

  private async markSyncFailure(failure: OutboxFailure, terminal = false): Promise<void> {
    await this.database.clickhouseSyncState.upsert({
      where: { pipelineName: this.pipelineName },
      create: {
        pipelineName: this.pipelineName,
        lagSeconds: 0n,
        status: terminal ? ClickhouseSyncStatus.FAILED : ClickhouseSyncStatus.DEGRADED,
        lastError: `${failure.code}: ${failure.message}`,
      },
      update: {
        status: terminal ? ClickhouseSyncStatus.FAILED : ClickhouseSyncStatus.DEGRADED,
        lastError: `${failure.code}: ${failure.message}`,
      },
    });
  }

  private leaseLost(lease: OutboxLease): RetryablePipelineError {
    return new RetryablePipelineError(
      "OUTBOX_LEASE_LOST",
      `Outbox lease ${lease.id.toString()} is no longer owned by ${lease.leaseOwner}`,
      { outbox_id: lease.id.toString(), event_type: lease.eventType },
    );
  }
}

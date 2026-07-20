import { Prisma, type DatabaseClient } from "@tokenpilot/db";

interface PurgedPayloadRow {
  readonly id: string;
  readonly event_id: string;
  readonly payload_hash: string;
  readonly payload_bytes: number;
  readonly payload_purge_after: Date;
  readonly payload_purged_at: Date;
}

export interface InboxPayloadCleanupMetric {
  readonly purgedPayloads: number;
  readonly purgedBytes: number;
  readonly completedAt: Date;
}

export interface InboxPayloadCleanupMetricsSink {
  record(metric: InboxPayloadCleanupMetric): void | Promise<void>;
}

export interface InboxPayloadCleanupOutcome extends InboxPayloadCleanupMetric {
  readonly eventIds: readonly string[];
}

const NOOP_METRICS: InboxPayloadCleanupMetricsSink = { record: () => undefined };

/** One-way privacy cleanup. Registry, rating, ledger, outbox, and audit lineage remain intact. */
export class InboxPayloadCleanupService {
  constructor(
    private readonly database: DatabaseClient,
    private readonly metrics: InboxPayloadCleanupMetricsSink = NOOP_METRICS,
  ) {}

  async purgeBatch(limit = 500): Promise<InboxPayloadCleanupOutcome> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
      throw new RangeError("Payload cleanup batch size must be between 1 and 5000");
    }
    const rows = await this.database.$transaction(
      async (transaction) => {
        const purged = await transaction.$queryRawUnsafe<PurgedPayloadRow[]>(
          `WITH candidates AS (
             SELECT inbox.id, inbox.event_id, registry.payload_hash,
                    pg_column_size(inbox.payload_json)::integer AS payload_bytes,
                    inbox.payload_purge_after
             FROM ingestion_inbox AS inbox
             JOIN usage_event_registry AS registry ON registry.event_id = inbox.event_id
             WHERE inbox.status = 'completed'
               AND inbox.stage = 'completed'
               AND inbox.payload_json IS NOT NULL
               AND inbox.payload_purge_after <= statement_timestamp()
               AND registry.clickhouse_raw_synced_at IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM dead_letter_events AS dead_letter
                 WHERE dead_letter.event_id = inbox.event_id
                   AND dead_letter.status IN ('open', 'replay_queued')
               )
               AND NOT EXISTS (
                 SELECT 1 FROM reconciliation_diffs AS diff
                 WHERE diff.status IN ('open', 'investigating')
                   AND jsonb_typeof(diff.sample_event_ids_json) = 'array'
                   AND diff.sample_event_ids_json ? inbox.event_id
               )
             ORDER BY inbox.payload_purge_after ASC, inbox.id ASC
             FOR UPDATE OF inbox SKIP LOCKED
             LIMIT $1
           )
           UPDATE ingestion_inbox AS inbox
           SET payload_json = NULL,
               payload_purged_at = statement_timestamp(),
               updated_at = statement_timestamp()
           FROM candidates
           WHERE inbox.id = candidates.id
           RETURNING inbox.id, inbox.event_id, candidates.payload_hash,
                     candidates.payload_bytes, candidates.payload_purge_after,
                     inbox.payload_purged_at`,
          limit,
        );
        if (purged.length > 0) {
          await transaction.auditLog.createMany({
            data: purged.map((row) => ({
              action: "pipeline.inbox_payload.purged",
              objectType: "ingestion_inbox",
              objectId: row.id,
              beforeJson: {
                event_id: row.event_id,
                payload_hash: row.payload_hash,
                payload_bytes: row.payload_bytes,
                payload_purge_after: row.payload_purge_after.toISOString(),
              },
              afterJson: {
                payload_retained: false,
                payload_purged_at: row.payload_purged_at.toISOString(),
                registry_and_rating_lineage_retained: true,
              },
              reason: "configured inbox payload TTL elapsed after ClickHouse raw acknowledgement",
            })),
          });
        }
        return purged;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    const metric: InboxPayloadCleanupMetric = {
      purgedPayloads: rows.length,
      purgedBytes: rows.reduce((total, row) => total + row.payload_bytes, 0),
      completedAt: new Date(),
    };
    try {
      await this.metrics.record(metric);
    } catch {
      // Observability failures must never roll back already-audited privacy cleanup.
    }
    return { ...metric, eventIds: rows.map((row) => row.event_id) };
  }
}

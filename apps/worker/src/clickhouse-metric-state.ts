import { CLICKHOUSE_PIPELINE_EVENT_TYPES, type ClickHouseOperations } from "@tokenpilot/clickhouse";
import { Prisma, type DatabaseClient } from "@tokenpilot/db";

export interface ClickHouseMetricState {
  readonly healthy: boolean;
  readonly outboxBacklog: number;
  readonly sinkLagSeconds: number;
  readonly rawWatermarkSeconds: number;
  readonly officialWatermarkSeconds: number;
  readonly storageUtilizationRatio?: number;
}

interface MetricStateRow {
  readonly outbox_backlog: number;
  readonly sink_lag_seconds: number;
  readonly raw_watermark_seconds: number;
  readonly official_watermark_seconds: number;
  readonly sync_healthy: boolean;
}

/** Reads bounded operational state from the authoritative PG handoff plus a live CH query. */
export class ClickHouseMetricStateReader {
  constructor(
    private readonly database: DatabaseClient,
    private readonly clickhouse: ClickHouseOperations,
  ) {}

  async read(now = new Date()): Promise<ClickHouseMetricState> {
    const eventTypes = Prisma.join([...CLICKHOUSE_PIPELINE_EVENT_TYPES]);
    const [rows, clickhouseHealthy, storageUtilizationRatio] = await Promise.all([
      this.database.$queryRaw<MetricStateRow[]>(Prisma.sql`
        SELECT
          (SELECT count(*)::float8
             FROM pipeline_outbox
            WHERE event_type IN (${eventTypes})
              AND status <> 'sent') AS outbox_backlog,
          GREATEST(
            (SELECT COALESCE(max(lag_seconds), 0)::float8 FROM clickhouse_sync_state),
            (SELECT COALESCE(EXTRACT(EPOCH FROM (${now} - min(created_at))), 0)::float8
               FROM pipeline_outbox
              WHERE event_type IN (${eventTypes})
                AND status <> 'sent')
          ) AS sink_lag_seconds,
          (SELECT COALESCE(EXTRACT(EPOCH FROM max(clickhouse_raw_synced_at)), 0)::float8
             FROM usage_event_registry) AS raw_watermark_seconds,
          (SELECT COALESCE(EXTRACT(EPOCH FROM max(clickhouse_official_synced_at)), 0)::float8
             FROM usage_event_registry) AS official_watermark_seconds,
          (SELECT COALESCE(bool_and(status = 'healthy'), true)
             FROM clickhouse_sync_state) AS sync_healthy
      `),
      this.liveQuery(),
      this.storageUtilization(),
    ]);
    const row = rows[0];
    if (row === undefined) throw new Error("PostgreSQL returned no ClickHouse metric state");
    return {
      healthy: clickhouseHealthy && row.sync_healthy,
      outboxBacklog: row.outbox_backlog,
      sinkLagSeconds: Math.max(0, row.sink_lag_seconds),
      rawWatermarkSeconds: Math.max(0, row.raw_watermark_seconds),
      officialWatermarkSeconds: Math.max(0, row.official_watermark_seconds),
      ...(storageUtilizationRatio === undefined ? {} : { storageUtilizationRatio }),
    };
  }

  private async liveQuery(): Promise<boolean> {
    try {
      const result = await this.clickhouse.queryRows<{ readonly healthy: number }>({
        name: "runtime_health.read",
        query: "SELECT 1 AS healthy",
      });
      return result.rows[0]?.healthy === 1;
    } catch {
      return false;
    }
  }

  private async storageUtilization(): Promise<number | undefined> {
    try {
      const result = await this.clickhouse.queryRows<{
        readonly storage_utilization_ratio: number;
      }>({
        name: "runtime_storage.read",
        query: `SELECT if(
          sum(total_space) = 0,
          0,
          (sum(total_space) - sum(free_space)) / sum(total_space)
        ) AS storage_utilization_ratio
        FROM system.disks`,
      });
      const ratio = result.rows[0]?.storage_utilization_ratio;
      return ratio === undefined || !Number.isFinite(ratio)
        ? undefined
        : Math.min(1, Math.max(0, ratio));
    } catch {
      return undefined;
    }
  }
}

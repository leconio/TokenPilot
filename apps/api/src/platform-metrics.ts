import { Counter, Gauge, Histogram, type Registry } from "prom-client";

import { Prisma } from "@tokenpilot/db";
import { OPERATIONAL_METRICS } from "@tokenpilot/shared";

interface MetricsDatabase {
  $queryRaw(query: Prisma.Sql): Promise<unknown>;
}

interface OperationalStateRow {
  readonly inbox_pending: number;
  readonly inbox_oldest_age: number;
  readonly outbox_backlog: number;
  readonly sink_lag: number;
  readonly raw_watermark: number;
  readonly official_watermark: number;
  readonly reservations_active: number;
  readonly negative_balance_users: number;
  readonly reconciliation_last_success: number;
}

export type ApiQuotaDecision = "allow" | "observe" | "warn" | "deny" | "downgrade";

export class ApiPlatformMetrics {
  private readonly ingestionEvents: Counter;
  private readonly ingestionBatches: Counter;
  private readonly ingestionRejected: Counter;
  private readonly ingestionDuplicates: Counter;
  private readonly ingestionPayloadConflicts: Counter;
  private readonly ingestionLatency: Histogram;
  private readonly inboxPending: Gauge;
  private readonly inboxOldestAge: Gauge;
  private readonly outboxBacklog: Gauge;
  private readonly sinkLag: Gauge;
  private readonly rawWatermark: Gauge;
  private readonly officialWatermark: Gauge;
  private readonly reservationsActive: Gauge;
  private readonly negativeBalanceUsers: Gauge;
  private readonly quotaChecks: Counter<"decision">;
  private readonly reconciliationLastSuccess: Gauge;

  constructor(
    registry: Registry<typeof Registry.OPENMETRICS_CONTENT_TYPE>,
    private readonly database: MetricsDatabase,
  ) {
    const counter = (metric: { name: string }, help: string) =>
      new Counter({ name: metric.name, help, registers: [registry] });
    const gauge = (metric: { name: string }, help: string) =>
      new Gauge({ name: metric.name, help, registers: [registry] });
    this.ingestionEvents = counter(
      OPERATIONAL_METRICS.ingestionEvents,
      "Events received by the ingestion API.",
    );
    this.ingestionBatches = counter(
      OPERATIONAL_METRICS.ingestionBatches,
      "Batches received by the ingestion API.",
    );
    this.ingestionRejected = counter(
      OPERATIONAL_METRICS.ingestionRejected,
      "Events rejected before Inbox persistence.",
    );
    this.ingestionDuplicates = counter(
      OPERATIONAL_METRICS.ingestionDuplicates,
      "Idempotent duplicate ingestion events.",
    );
    this.ingestionPayloadConflicts = counter(
      OPERATIONAL_METRICS.ingestionPayloadConflicts,
      "Event identity collisions with different payloads.",
    );
    this.ingestionLatency = new Histogram({
      name: OPERATIONAL_METRICS.ingestionLatency.name,
      help: "Ingestion acceptance and Inbox persistence latency.",
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2.5],
      registers: [registry],
    });
    this.inboxPending = gauge(
      OPERATIONAL_METRICS.inboxPending,
      "Inbox records awaiting completion.",
    );
    this.inboxOldestAge = gauge(
      OPERATIONAL_METRICS.inboxOldestAge,
      "Age of the oldest incomplete Inbox record.",
    );
    this.outboxBacklog = gauge(
      OPERATIONAL_METRICS.clickhouseOutboxBacklog,
      "ClickHouse outbox records awaiting acknowledgement.",
    );
    this.sinkLag = gauge(OPERATIONAL_METRICS.clickhouseSinkLag, "ClickHouse sink lag in seconds.");
    this.rawWatermark = gauge(
      OPERATIONAL_METRICS.clickhouseRawWatermark,
      "Latest raw projection acknowledgement Unix timestamp.",
    );
    this.officialWatermark = gauge(
      OPERATIONAL_METRICS.clickhouseOfficialWatermark,
      "Latest official projection acknowledgement Unix timestamp.",
    );
    this.reservationsActive = gauge(
      OPERATIONAL_METRICS.quotaReservationsActive,
      "Active quota reservations.",
    );
    this.negativeBalanceUsers = gauge(
      OPERATIONAL_METRICS.quotaNegativeBalanceUsers,
      "Application users with negative AIU balances.",
    );
    this.quotaChecks = new Counter({
      name: OPERATIONAL_METRICS.quotaCheck.name,
      help: "Authoritative runtime quota checks by bounded decision outcome.",
      labelNames: ["decision"] as const,
      registers: [registry],
    });
    this.reconciliationLastSuccess = gauge(
      OPERATIONAL_METRICS.reconciliationLastSuccess,
      "Last successful reconciliation Unix timestamp.",
    );
  }

  recordIngestion(result: {
    readonly accepted: number;
    readonly duplicates: number;
    readonly rejected: number;
    readonly payloadConflicts?: number;
    readonly latencySeconds?: number;
  }): void {
    const total = result.accepted + result.duplicates + result.rejected;
    this.ingestionBatches.inc();
    if (total > 0) this.ingestionEvents.inc(total);
    if (result.rejected > 0) this.ingestionRejected.inc(result.rejected);
    if (result.duplicates > 0) this.ingestionDuplicates.inc(result.duplicates);
    if ((result.payloadConflicts ?? 0) > 0)
      this.ingestionPayloadConflicts.inc(result.payloadConflicts);
    if (result.latencySeconds !== undefined) this.ingestionLatency.observe(result.latencySeconds);
  }

  recordPayloadConflict(count = 1): void {
    this.ingestionPayloadConflicts.inc(count);
  }

  observeIngestion(seconds: number): void {
    this.ingestionLatency.observe(seconds);
  }

  recordQuota(decision: ApiQuotaDecision): void {
    this.quotaChecks.inc({ decision });
  }

  async refresh(now = new Date()): Promise<void> {
    const rows = (await this.database.$queryRaw(Prisma.sql`
      SELECT
        (SELECT count(*)::float8 FROM ingestion_inbox WHERE status <> 'completed') AS inbox_pending,
        (SELECT COALESCE(EXTRACT(EPOCH FROM (${now} - min(created_at))), 0)::float8
           FROM ingestion_inbox WHERE status <> 'completed') AS inbox_oldest_age,
        (SELECT count(*)::float8 FROM pipeline_outbox
           WHERE status <> 'sent' AND aggregate_type IN
             ('usage_event', 'usage_line', 'application_usage_rating')) AS outbox_backlog,
        (SELECT COALESCE(max(lag_seconds), 0)::float8 FROM clickhouse_sync_state) AS sink_lag,
        (SELECT COALESCE(EXTRACT(EPOCH FROM max(clickhouse_raw_synced_at)), 0)::float8
           FROM usage_event_registry) AS raw_watermark,
        (SELECT COALESCE(EXTRACT(EPOCH FROM max(clickhouse_official_synced_at)), 0)::float8
           FROM usage_event_registry) AS official_watermark,
        (SELECT count(*)::float8 FROM user_aiu_reservations
           WHERE status = 'reserved') AS reservations_active,
        (SELECT count(*)::float8 FROM user_aiu_quotas
           WHERE enabled AND consumed_aiu_micros + reserved_aiu_micros >
             limit_aiu_micros) AS negative_balance_users,
        (SELECT COALESCE(EXTRACT(EPOCH FROM max(finished_at)), 0)::float8
           FROM reconciliation_runs WHERE status = 'completed') AS reconciliation_last_success
    `)) as OperationalStateRow[];
    const [row] = rows;
    if (row === undefined) throw new Error("PostgreSQL returned no operational metric state");
    this.inboxPending.set(row.inbox_pending);
    this.inboxOldestAge.set(Math.max(0, row.inbox_oldest_age));
    this.outboxBacklog.set(row.outbox_backlog);
    this.sinkLag.set(row.sink_lag);
    this.rawWatermark.set(row.raw_watermark);
    this.officialWatermark.set(row.official_watermark);
    this.reservationsActive.set(row.reservations_active);
    this.negativeBalanceUsers.set(row.negative_balance_users);
    this.reconciliationLastSuccess.set(row.reconciliation_last_success);
  }
}

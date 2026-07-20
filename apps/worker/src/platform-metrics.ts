import { Counter, Gauge, Histogram, type Registry } from "prom-client";

import type { ReconciliationDiffType } from "@tokenpilot/reconciliation-engine";
import { OPERATIONAL_METRICS } from "@tokenpilot/shared";

export type SettlementStage =
  | "normalization"
  | "model_resolution"
  | "provider_cost"
  | "aiu"
  | "quota"
  | "official_commit"
  | "outbox"
  | "clickhouse";
export type SettlementStatus = "completed" | "retry" | "failed" | "dead_letter";
export type QuotaDecision = "allow" | "observe" | "warn" | "deny" | "downgrade";
export type ReconciliationRunType = "hourly" | "daily" | "manual" | "rebuild";
export type ReconciliationStatus = "completed" | "failed" | "cancelled";
export type ReconciliationSeverity = "info" | "warning" | "error" | "critical";

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

function positive(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("metric value must be a non-negative finite number");
  }
  return value;
}

export class WorkerPlatformMetrics {
  private readonly settlementEvents: Counter<"stage" | "status">;
  private readonly settlementLatency: Histogram;
  private readonly settlementRetry: Counter;
  private readonly settlementDlq: Counter;
  private readonly providerCostUnpriced: Counter;
  private readonly aiuUnrated: Counter;
  private readonly modelUnmapped: Counter;
  private readonly clickhouseHealth: Gauge;
  private readonly clickhouseRows: Counter;
  private readonly clickhouseBytes: Counter;
  private readonly clickhouseInsertLatency: Histogram;
  private readonly clickhouseInsertFailures: Counter;
  private readonly clickhouseQueryLatency: Histogram;
  private readonly clickhouseQueryFailures: Counter;
  private readonly clickhouseOutboxBacklog: Gauge;
  private readonly clickhouseSinkLag: Gauge;
  private readonly clickhouseRawWatermark: Gauge;
  private readonly clickhouseOfficialWatermark: Gauge;
  private readonly clickhouseStorageUtilization: Gauge;
  private readonly aiuRated: Counter;
  private readonly aiuConsumed: Counter;
  private readonly aiuAdjusted: Counter;
  private readonly quotaChecks: Counter<"decision">;
  private readonly reservationsActive: Gauge;
  private readonly reservationsExpired: Counter;
  private readonly negativeBalanceUsers: Gauge;
  private readonly reconciliationRuns: Counter<"run_type" | "status">;
  private readonly reconciliationDiffs: Counter<"diff_type" | "severity">;
  private readonly reconciliationCostDelta: Gauge;
  private readonly reconciliationAiuDelta: Gauge;
  private readonly reconciliationLastSuccess: Gauge;

  constructor(registry: Registry<typeof Registry.OPENMETRICS_CONTENT_TYPE>) {
    const counter = (metric: { name: string }, help: string) =>
      new Counter({ name: metric.name, help, registers: [registry] });
    const gauge = (metric: { name: string }, help: string) =>
      new Gauge({ name: metric.name, help, registers: [registry] });
    const histogram = (metric: { name: string }, help: string) =>
      new Histogram({ name: metric.name, help, buckets: LATENCY_BUCKETS, registers: [registry] });
    this.settlementEvents = new Counter({
      name: OPERATIONAL_METRICS.settlementEvents.name,
      help: "Settlement outcomes by bounded stage and status.",
      labelNames: ["stage", "status"] as const,
      registers: [registry],
    });
    this.settlementLatency = histogram(
      OPERATIONAL_METRICS.settlementLatency,
      "End-to-end settlement latency.",
    );
    this.settlementRetry = counter(OPERATIONAL_METRICS.settlementRetry, "Settlement retries.");
    this.settlementDlq = counter(OPERATIONAL_METRICS.settlementDlq, "Settlement DLQ writes.");
    this.providerCostUnpriced = counter(
      OPERATIONAL_METRICS.providerCostUnpriced,
      "Provider cost outcomes without a price.",
    );
    this.aiuUnrated = counter(OPERATIONAL_METRICS.aiuUnrated, "AIU outcomes without a rate.");
    this.modelUnmapped = counter(
      OPERATIONAL_METRICS.modelUnmapped,
      "Events whose LiteLLM model tag is not configured.",
    );
    this.clickhouseHealth = gauge(OPERATIONAL_METRICS.clickhouseHealth, "ClickHouse health state.");
    this.clickhouseRows = counter(
      OPERATIONAL_METRICS.clickhouseInsertRows,
      "Rows acknowledged by ClickHouse.",
    );
    this.clickhouseBytes = counter(
      OPERATIONAL_METRICS.clickhouseInsertBytes,
      "Payload bytes acknowledged by ClickHouse.",
    );
    this.clickhouseInsertLatency = histogram(
      OPERATIONAL_METRICS.clickhouseInsertLatency,
      "ClickHouse insert latency.",
    );
    this.clickhouseInsertFailures = counter(
      OPERATIONAL_METRICS.clickhouseInsertFailures,
      "Failed ClickHouse inserts.",
    );
    this.clickhouseQueryLatency = histogram(
      OPERATIONAL_METRICS.clickhouseQueryLatency,
      "ClickHouse query latency.",
    );
    this.clickhouseQueryFailures = counter(
      OPERATIONAL_METRICS.clickhouseQueryFailures,
      "Failed ClickHouse queries.",
    );
    this.clickhouseOutboxBacklog = gauge(
      OPERATIONAL_METRICS.clickhouseOutboxBacklog,
      "Undelivered ClickHouse outbox records.",
    );
    this.clickhouseSinkLag = gauge(
      OPERATIONAL_METRICS.clickhouseSinkLag,
      "ClickHouse sink lag in seconds.",
    );
    this.clickhouseRawWatermark = gauge(
      OPERATIONAL_METRICS.clickhouseRawWatermark,
      "Raw projection watermark Unix timestamp.",
    );
    this.clickhouseOfficialWatermark = gauge(
      OPERATIONAL_METRICS.clickhouseOfficialWatermark,
      "Official projection watermark Unix timestamp.",
    );
    this.clickhouseStorageUtilization = gauge(
      OPERATIONAL_METRICS.clickhouseStorageUtilization,
      "ClickHouse storage utilization ratio.",
    );
    this.aiuRated = counter(OPERATIONAL_METRICS.aiuRatedMicros, "Rated micro-AIU.");
    this.aiuConsumed = counter(OPERATIONAL_METRICS.aiuConsumedMicros, "Consumed micro-AIU.");
    this.aiuAdjusted = counter(OPERATIONAL_METRICS.aiuAdjustedMicros, "Adjusted micro-AIU.");
    this.quotaChecks = new Counter({
      name: OPERATIONAL_METRICS.quotaCheck.name,
      help: "Quota decisions by bounded decision.",
      labelNames: ["decision"] as const,
      registers: [registry],
    });
    this.reservationsActive = gauge(
      OPERATIONAL_METRICS.quotaReservationsActive,
      "Active quota reservations.",
    );
    this.reservationsExpired = counter(
      OPERATIONAL_METRICS.quotaReservationExpired,
      "Expired quota reservations.",
    );
    this.negativeBalanceUsers = gauge(
      OPERATIONAL_METRICS.quotaNegativeBalanceUsers,
      "Application users with a negative AIU balance.",
    );
    this.reconciliationRuns = new Counter({
      name: OPERATIONAL_METRICS.reconciliationRuns.name,
      help: "Reconciliation run outcomes.",
      labelNames: ["run_type", "status"] as const,
      registers: [registry],
    });
    this.reconciliationDiffs = new Counter({
      name: OPERATIONAL_METRICS.reconciliationDiff.name,
      help: "Reconciliation differences by bounded type and severity.",
      labelNames: ["diff_type", "severity"] as const,
      registers: [registry],
    });
    this.reconciliationCostDelta = gauge(
      OPERATIONAL_METRICS.reconciliationCostDelta,
      "Absolute provider-cost reconciliation delta.",
    );
    this.reconciliationAiuDelta = gauge(
      OPERATIONAL_METRICS.reconciliationAiuMicroDelta,
      "Absolute micro-AIU reconciliation delta.",
    );
    this.reconciliationLastSuccess = gauge(
      OPERATIONAL_METRICS.reconciliationLastSuccess,
      "Last successful reconciliation Unix timestamp.",
    );
  }

  recordSettlement(input: {
    stage: SettlementStage;
    status: SettlementStatus;
    latencySeconds?: number;
    count?: number;
  }): void {
    const count = positive(input.count ?? 1);
    this.settlementEvents.inc({ stage: input.stage, status: input.status }, count);
    if (input.latencySeconds !== undefined)
      this.settlementLatency.observe(positive(input.latencySeconds));
    if (input.status === "retry") this.settlementRetry.inc(count);
    if (input.status === "dead_letter") this.settlementDlq.inc(count);
  }

  observeSettlementLatency(latencySeconds: number): void {
    this.settlementLatency.observe(positive(latencySeconds));
  }

  recordRating(input: {
    providerCostUnpriced?: boolean;
    aiuUnrated?: boolean;
    modelUnmapped?: boolean;
    ratedAiuMicros?: number;
    consumedAiuMicros?: number;
    adjustedAiuMicros?: number;
  }): void {
    if (input.providerCostUnpriced === true) this.providerCostUnpriced.inc();
    if (input.aiuUnrated === true) this.aiuUnrated.inc();
    if (input.modelUnmapped === true) this.modelUnmapped.inc();
    if (input.ratedAiuMicros !== undefined) this.aiuRated.inc(positive(input.ratedAiuMicros));
    if (input.consumedAiuMicros !== undefined)
      this.aiuConsumed.inc(positive(input.consumedAiuMicros));
    if (input.adjustedAiuMicros !== undefined)
      this.aiuAdjusted.inc(positive(input.adjustedAiuMicros));
  }

  recordClickHouse(input: {
    operation: "insert" | "query";
    success: boolean;
    latencySeconds: number;
    rows?: number;
    bytes?: number;
  }): void {
    const latency = positive(input.latencySeconds);
    if (input.operation === "insert") {
      this.clickhouseInsertLatency.observe(latency);
      if (!input.success) this.clickhouseInsertFailures.inc();
      if (input.rows !== undefined) this.clickhouseRows.inc(positive(input.rows));
      if (input.bytes !== undefined) this.clickhouseBytes.inc(positive(input.bytes));
    } else {
      this.clickhouseQueryLatency.observe(latency);
      if (!input.success) this.clickhouseQueryFailures.inc();
    }
  }

  setClickHouseState(input: {
    healthy: boolean;
    outboxBacklog: number;
    sinkLagSeconds: number;
    rawWatermarkSeconds: number;
    officialWatermarkSeconds: number;
    storageUtilizationRatio?: number;
  }): void {
    this.clickhouseHealth.set(input.healthy ? 1 : 0);
    this.clickhouseOutboxBacklog.set(positive(input.outboxBacklog));
    this.clickhouseSinkLag.set(positive(input.sinkLagSeconds));
    this.clickhouseRawWatermark.set(positive(input.rawWatermarkSeconds));
    this.clickhouseOfficialWatermark.set(positive(input.officialWatermarkSeconds));
    if (input.storageUtilizationRatio !== undefined) {
      this.clickhouseStorageUtilization.set(positive(input.storageUtilizationRatio));
    }
  }

  setClickHouseHealthy(healthy: boolean): void {
    this.clickhouseHealth.set(healthy ? 1 : 0);
  }

  recordQuota(decision: QuotaDecision): void {
    this.quotaChecks.inc({ decision });
  }

  setQuotaState(activeReservations: number, negativeBalanceUsers: number): void {
    this.reservationsActive.set(positive(activeReservations));
    this.negativeBalanceUsers.set(positive(negativeBalanceUsers));
  }

  recordExpiredReservations(count = 1): void {
    this.reservationsExpired.inc(positive(count));
  }

  recordReconciliation(input: {
    runType: ReconciliationRunType;
    status: ReconciliationStatus;
    diffs?: ReadonlyArray<{
      type: ReconciliationDiffType;
      severity: ReconciliationSeverity;
      count: number;
    }>;
    costDelta?: number;
    aiuMicroDelta?: number;
    finishedAt?: Date;
  }): void {
    this.reconciliationRuns.inc({ run_type: input.runType, status: input.status });
    for (const diff of input.diffs ?? []) {
      this.reconciliationDiffs.inc(
        { diff_type: diff.type, severity: diff.severity },
        positive(diff.count),
      );
    }
    if (input.costDelta !== undefined)
      this.reconciliationCostDelta.set(positive(Math.abs(input.costDelta)));
    if (input.aiuMicroDelta !== undefined)
      this.reconciliationAiuDelta.set(positive(Math.abs(input.aiuMicroDelta)));
    if (input.status === "completed")
      this.reconciliationLastSuccess.set(
        positive((input.finishedAt ?? new Date()).getTime()) / 1_000,
      );
  }
}

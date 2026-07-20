import type { ReconciliationJobData } from "@tokenpilot/shared";

import type { ClickHouseOutboxBatchOutcome, PipelineProcessOutcome } from "./pipeline/index.js";
import type { WorkerPlatformMetrics } from "./platform-metrics.js";
import type { ReconciliationRunSummary } from "./reconciliation/index.js";

function unsignedMetricNumber(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError("pipeline metric micros must be a non-negative integer");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new RangeError("pipeline metric micros exceed float range");
  return parsed;
}

function finiteMetricNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new RangeError("metric value exceeds float range");
  return parsed;
}

export function recordPipelineOutcomes(
  metrics: WorkerPlatformMetrics,
  outcomes: readonly PipelineProcessOutcome[],
): void {
  for (const outcome of outcomes) {
    outcome.stageMetrics.forEach((metric) => {
      metrics.recordSettlement({
        stage: metric.stage,
        status: metric.status,
      });
    });
    metrics.observeSettlementLatency(outcome.durationSeconds);
    if (outcome.ratingMetrics === undefined) continue;
    metrics.recordRating({
      ...(outcome.ratingMetrics.providerCostUnpriced === undefined
        ? {}
        : { providerCostUnpriced: outcome.ratingMetrics.providerCostUnpriced }),
      ...(outcome.ratingMetrics.aiuUnrated === undefined
        ? {}
        : { aiuUnrated: outcome.ratingMetrics.aiuUnrated }),
      ...(outcome.ratingMetrics.modelUnmapped === undefined
        ? {}
        : { modelUnmapped: outcome.ratingMetrics.modelUnmapped }),
      ...(outcome.ratingMetrics.ratedAiuMicros === undefined
        ? {}
        : { ratedAiuMicros: unsignedMetricNumber(outcome.ratingMetrics.ratedAiuMicros) }),
      ...(outcome.ratingMetrics.consumedAiuMicros === undefined
        ? {}
        : { consumedAiuMicros: unsignedMetricNumber(outcome.ratingMetrics.consumedAiuMicros) }),
    });
    if (outcome.ratingMetrics.quotaDecision !== undefined) {
      metrics.recordQuota(outcome.ratingMetrics.quotaDecision);
    }
  }
}

export function recordClickHouseOutboxOutcome(
  metrics: WorkerPlatformMetrics,
  outcome: ClickHouseOutboxBatchOutcome,
): void {
  if (outcome.delivered > 0) {
    metrics.recordSettlement({
      stage: "clickhouse",
      status: "completed",
      count: outcome.delivered,
    });
  }
  if (outcome.retried > 0) {
    metrics.recordSettlement({ stage: "clickhouse", status: "retry", count: outcome.retried });
  }
  if (outcome.deadLettered > 0) {
    metrics.recordSettlement({
      stage: "clickhouse",
      status: "dead_letter",
      count: outcome.deadLettered,
    });
  }
}

function reconciliationSummary(value: unknown): ReconciliationRunSummary | null {
  if (
    value === null ||
    typeof value !== "object" ||
    !Array.isArray((value as { readonly metricDiffs?: unknown }).metricDiffs) ||
    typeof (value as { readonly providerCostDelta?: unknown }).providerCostDelta !== "string" ||
    typeof (value as { readonly aiuMicroDelta?: unknown }).aiuMicroDelta !== "string"
  ) {
    return null;
  }
  return value as ReconciliationRunSummary;
}

export function recordReconciliationCompletion(
  metrics: WorkerPlatformMetrics,
  data: ReconciliationJobData,
  result: unknown,
  finishedAt = new Date(),
): void {
  if (data.kind === "rebuild" || data.kind === "replay") {
    metrics.recordReconciliation({
      runType: data.kind === "rebuild" ? "rebuild" : "manual",
      status: "completed",
      finishedAt,
    });
    return;
  }
  const summary = reconciliationSummary(result);
  // A null result means another worker already claimed this durable run.
  if (summary === null) return;
  metrics.recordReconciliation({
    runType: data.kind === "schedule" ? data.runType : "manual",
    status: "completed",
    diffs: summary.metricDiffs.map((diff) => ({
      type: diff.type,
      severity: diff.severity,
      count: unsignedMetricNumber(diff.count),
    })),
    costDelta: finiteMetricNumber(summary.providerCostDelta),
    aiuMicroDelta: finiteMetricNumber(summary.aiuMicroDelta),
    finishedAt,
  });
}

export function reconciliationRunType(data: ReconciliationJobData | undefined) {
  if (data?.kind === "rebuild") return "rebuild" as const;
  if (data?.kind === "schedule") return data.runType;
  return "manual" as const;
}

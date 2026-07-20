import { describe, expect, it, vi } from "vitest";

import type { WorkerPlatformMetrics } from "../src/platform-metrics.js";
import {
  recordClickHouseOutboxOutcome,
  recordPipelineOutcomes,
  recordReconciliationCompletion,
} from "../src/runtime-metric-recording.js";

function metrics() {
  return {
    recordSettlement: vi.fn(),
    observeSettlementLatency: vi.fn(),
    recordRating: vi.fn(),
    recordQuota: vi.fn(),
    recordReconciliation: vi.fn(),
  } as unknown as WorkerPlatformMetrics;
}

describe("runtime metric recording", () => {
  it("records each pipeline stage once and observes end-to-end latency once", () => {
    const platform = metrics();
    recordPipelineOutcomes(platform, [
      {
        eventId: "event-1",
        status: "retry_scheduled",
        stage: "provider_cost_rated",
        durationSeconds: 0.25,
        stageMetrics: [
          { stage: "normalization", status: "completed" },
          { stage: "model_resolution", status: "completed" },
          { stage: "provider_cost", status: "retry" },
        ],
        ratingMetrics: {
          providerCostUnpriced: true,
          aiuUnrated: true,
          modelUnmapped: true,
          ratedAiuMicros: "125",
          consumedAiuMicros: "100",
          quotaDecision: "allow",
        },
        errorCode: "PRICE_UNAVAILABLE",
      },
    ]);

    expect(platform.recordSettlement).toHaveBeenCalledTimes(3);
    expect(platform.recordSettlement).toHaveBeenNthCalledWith(1, {
      stage: "normalization",
      status: "completed",
    });
    expect(platform.recordSettlement).toHaveBeenNthCalledWith(3, {
      stage: "provider_cost",
      status: "retry",
    });
    expect(platform.observeSettlementLatency).toHaveBeenCalledOnce();
    expect(platform.observeSettlementLatency).toHaveBeenCalledWith(0.25);
    expect(platform.recordRating).toHaveBeenCalledWith({
      providerCostUnpriced: true,
      aiuUnrated: true,
      modelUnmapped: true,
      ratedAiuMicros: 125,
      consumedAiuMicros: 100,
    });
    expect(platform.recordQuota).toHaveBeenCalledWith("allow");
  });

  it("records mixed ClickHouse delivery outcomes by durable outbox row", () => {
    const platform = metrics();
    recordClickHouseOutboxOutcome(platform, {
      status: "retry_scheduled",
      leased: 6,
      delivered: 2,
      retried: 3,
      deadLettered: 1,
    });

    expect(platform.recordSettlement).toHaveBeenCalledTimes(3);
    expect(platform.recordSettlement).toHaveBeenCalledWith({
      stage: "clickhouse",
      status: "completed",
      count: 2,
    });
    expect(platform.recordSettlement).toHaveBeenCalledWith({
      stage: "clickhouse",
      status: "retry",
      count: 3,
    });
    expect(platform.recordSettlement).toHaveBeenCalledWith({
      stage: "clickhouse",
      status: "dead_letter",
      count: 1,
    });
  });

  it("publishes reconciliation diffs and signed deltas from the completed run result", () => {
    const platform = metrics();
    const finishedAt = new Date("2026-07-16T12:00:00.000Z");
    recordReconciliationCompletion(
      platform,
      { kind: "schedule", runType: "hourly" },
      {
        totalDiffs: 1,
        byType: { LEDGER_PROJECTION_MISSING: 1 },
        bySeverity: { critical: 1 },
        sampleEventCount: 1,
        metricDiffs: [{ type: "LEDGER_PROJECTION_MISSING", severity: "critical", count: "2" }],
        providerCostDelta: "-1.25",
        aiuMicroDelta: "-40",
      },
      finishedAt,
    );

    expect(platform.recordReconciliation).toHaveBeenCalledWith({
      runType: "hourly",
      status: "completed",
      diffs: [{ type: "LEDGER_PROJECTION_MISSING", severity: "critical", count: 2 }],
      costDelta: -1.25,
      aiuMicroDelta: -40,
      finishedAt,
    });
  });

  it("does not count a completed job when the durable run was already claimed", () => {
    const platform = metrics();
    recordReconciliationCompletion(platform, { kind: "run", runId: "run-1" }, null);
    expect(platform.recordReconciliation).not.toHaveBeenCalled();
  });
});

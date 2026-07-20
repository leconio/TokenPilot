import {
  planReconciliationRun,
  type ReconciliationDiff,
  type ReconciliationSnapshotRow,
} from "@tokenpilot/reconciliation-engine";
import { describe, expect, it } from "vitest";

import { ReconciliationRunner } from "../../src/reconciliation/runner.js";
import type {
  ReconciliationRepository,
  ReconciliationRunClaim,
  ReconciliationRunSummary,
  ReconciliationWatermarks,
} from "../../src/reconciliation/types.js";

const plan = planReconciliationRun({
  applicationId: "00000000-0000-4000-8000-000000000001",
  runType: "hourly",
  rangeStart: "2026-07-16T00:00:00.000Z",
  rangeEnd: "2026-07-16T01:00:00.000Z",
});

function row(projectionId: string, userId = "user-secret"): ReconciliationSnapshotRow {
  return {
    projectionId,
    dimensions: {
      applicationId: plan.applicationId,
      bucketStart: plan.rangeStart,
      bucketSize: "hour",
      virtualModel: "chat-fast",
      modelId: "model-1",
      modelTag: "openai-primary",
      provider: "openai",
      userId,
    },
    metrics: {
      eventCount: "1",
      inputTokens: "10",
      cachedInputTokens: "0",
      outputTokens: "3",
      providerCost: projectionId === "pg" ? "0.100000000000000000" : "0",
      aiuMicros: "100",
      unpricedCount: "0",
      unratedCount: "0",
    },
    sampleEventIds: ["event-1"],
    modelIdentityFingerprint: "sha256:model-identity",
    costVersionId: "cost-current",
    aiuVersionId: "aiu-current",
    payloadHashConflict: false,
    officialDeltaPending: false,
    lateEventCount: "0",
    unprojectedAdjustmentCount: "0",
  };
}

class MemoryRepository implements ReconciliationRepository {
  claimValue: ReconciliationRunClaim | null = { id: "run-1", plan };
  diffs: readonly ReconciliationDiff[] = [];
  summary: ReconciliationRunSummary | null = null;
  failure: Error | null = null;

  async listApplicationIds(): Promise<readonly string[]> {
    return [plan.applicationId];
  }

  async createQueued(): Promise<{ readonly id: string }> {
    return { id: "run-1" };
  }
  async claim(): Promise<ReconciliationRunClaim | null> {
    const result = this.claimValue;
    this.claimValue = null;
    return result;
  }
  async replaceDiffs(_runId: string, diffs: readonly ReconciliationDiff[]): Promise<void> {
    this.diffs = diffs;
  }
  async complete(
    _runId: string,
    _watermarks: ReconciliationWatermarks,
    summary: ReconciliationRunSummary,
  ): Promise<void> {
    this.summary = summary;
  }
  async fail(_runId: string, error: Error): Promise<void> {
    this.failure = error;
  }
  async listDiffs(): Promise<readonly ReconciliationDiff[]> {
    return this.diffs;
  }
}

const watermarks: ReconciliationWatermarks = {
  pgEventTime: "2026-07-16T00:59:00.000Z",
  chEventTime: "2026-07-16T00:59:00.000Z",
  chLastSuccessAt: "2026-07-16T01:00:00.000Z",
};

describe("ReconciliationRunner", () => {
  it("persists complete diffs with pseudonymous users and exports CSV", async () => {
    const repository = new MemoryRepository();
    const runner = new ReconciliationRunner(
      repository,
      {
        loadPostgres: async () => [row("pg")],
        loadClickHouse: async () => [row("ch")],
        loadWatermarks: async () => watermarks,
      },
      {
        userHmacSecret: "0123456789abcdef0123456789abcdef",
        tolerance: { providerCost: "0", aiuMicros: "0", watermarkStallSeconds: 60 },
        now: () => new Date("2026-07-16T01:00:00.000Z"),
      },
    );

    const summary = await runner.execute("run-1");
    expect(summary?.totalDiffs).toBe(1);
    expect(summary?.metricDiffs).toEqual([
      { type: "LEDGER_PROJECTION_MISSING", severity: "critical", count: "1" },
    ]);
    expect(summary?.providerCostDelta).toBe("0.1");
    expect(summary?.aiuMicroDelta).toBe("0");
    expect(summary?.authoritativeMetrics).toEqual({
      eventCount: "1",
      inputTokens: "10",
      cachedInputTokens: "0",
      outputTokens: "3",
      providerCost: "0.1",
      aiuMicros: "100",
      unpricedCount: "0",
      unratedCount: "0",
    });
    expect(repository.diffs[0]?.type).toBe("LEDGER_PROJECTION_MISSING");
    expect(repository.diffs[0]?.amount).toBe("0.100000000000000000");
    expect(repository.diffs[0]?.dimensions?.userId).toMatch(/^user_hmac:[a-f0-9]{64}$/u);
    expect(JSON.stringify(repository.diffs)).not.toContain("user-secret");
    expect(await runner.exportCsv("run-1")).toContain("LEDGER_PROJECTION_MISSING");
  });

  it("claims each run once", async () => {
    const repository = new MemoryRepository();
    const runner = new ReconciliationRunner(
      repository,
      {
        loadPostgres: async () => [],
        loadClickHouse: async () => [],
        loadWatermarks: async () => watermarks,
      },
      {
        userHmacSecret: "0123456789abcdef0123456789abcdef",
        tolerance: { providerCost: "0", aiuMicros: "0", watermarkStallSeconds: 60 },
      },
    );
    expect(await runner.execute("run-1")).not.toBeNull();
    expect(await runner.execute("run-1")).toBeNull();
  });

  it("marks claimed runs failed without leaking a user into logs", async () => {
    const repository = new MemoryRepository();
    const attributes: unknown[] = [];
    const runner = new ReconciliationRunner(
      repository,
      {
        loadPostgres: async () => {
          throw new Error("source unavailable");
        },
        loadClickHouse: async () => [],
        loadWatermarks: async () => watermarks,
      },
      {
        userHmacSecret: "0123456789abcdef0123456789abcdef",
        tolerance: { providerCost: "0", aiuMicros: "0", watermarkStallSeconds: 60 },
        logger: {
          info: (_event, value) => attributes.push(value),
          error: (_event, value) => attributes.push(value),
        },
      },
    );
    await expect(runner.execute("run-1")).rejects.toThrow("source unavailable");
    expect(repository.failure?.message).toBe("source unavailable");
    expect(JSON.stringify(attributes)).not.toContain("user-secret");
  });
});

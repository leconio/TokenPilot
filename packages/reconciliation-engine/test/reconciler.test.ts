import { describe, expect, it } from "vitest";

import { reconcileSnapshots } from "../src/index.js";

import type { ReconciliationMetrics, ReconciliationSnapshotRow } from "../src/index.js";

function metrics(overrides: Partial<ReconciliationMetrics> = {}): ReconciliationMetrics {
  return {
    eventCount: "10",
    inputTokens: "1250",
    cachedInputTokens: "250",
    outputTokens: "500",
    providerCost: "12.500000000000000000",
    aiuMicros: "2500000",
    unpricedCount: "1",
    unratedCount: "2",
    ...overrides,
  };
}

function row(
  projectionId: string,
  overrides: Partial<ReconciliationSnapshotRow> = {},
): ReconciliationSnapshotRow {
  return {
    projectionId,
    dimensions: {
      applicationId: "00000000-0000-4000-8000-000000000001",
      bucketStart: "2026-07-16T00:00:00.000Z",
      bucketSize: "hour",
      virtualModel: "chat-fast",
      modelId: "model-1",
      modelTag: "openai-primary",
      provider: "openai",
      userId: null,
    },
    metrics: metrics(),
    sampleEventIds: ["event-1", "event-2"],
    modelIdentityFingerprint: `sha256:${"a".repeat(64)}`,
    costVersionId: "price-current",
    aiuVersionId: "aiu-current",
    payloadHashConflict: false,
    officialDeltaPending: false,
    lateEventCount: "0",
    unprojectedAdjustmentCount: "0",
    ...overrides,
  };
}

const tolerance = {
  providerCost: "0.000001",
  aiuMicros: "0",
  watermarkStallSeconds: 60,
} as const;

describe("PostgreSQL/ClickHouse reconciliation", () => {
  it("returns no diff for identical official and projected aggregates", () => {
    expect(reconcileSnapshots({ pgRows: [row("pg")], chRows: [row("ch")], tolerance })).toEqual([]);
  });

  it("detects missing and duplicate projections with counts and samples", () => {
    const first = row("pg-first");
    const second = row("pg-second");
    const diffs = reconcileSnapshots({ pgRows: [first, second], chRows: [], tolerance });
    expect(diffs.map((entry) => entry.type)).toEqual(["DUPLICATE_PROJECTION", "CH_MISSING"]);
    expect(diffs[0]).toMatchObject({ severity: "error", count: "1" });
    expect(diffs[1]!.sampleEventIds).toEqual(["event-1", "event-2"]);

    expect(reconcileSnapshots({ pgRows: [], chRows: [row("orphan")], tolerance })[0]).toMatchObject(
      { type: "PG_MISSING", severity: "warning", count: "10" },
    );
  });

  it("detects physical ClickHouse rows hidden behind distinct event aggregation", () => {
    const diffs = reconcileSnapshots({
      pgRows: [row("pg")],
      chRows: [row("ch", { duplicateProjectionCount: "2" })],
      tolerance,
    });

    expect(diffs).toEqual([
      expect.objectContaining({
        type: "DUPLICATE_PROJECTION",
        severity: "error",
        count: "2",
      }),
    ]);
  });

  it("rejects an invalid physical duplicate count", () => {
    expect(() =>
      reconcileSnapshots({
        pgRows: [row("pg")],
        chRows: [row("ch", { duplicateProjectionCount: "-1" })],
        tolerance,
      }),
    ).toThrow("duplicateProjectionCount must be a non-negative integer string");
  });

  it("classifies contract, version, usage, pending delta, ledger, late, and adjustment differences", () => {
    const pg = row("pg", {
      payloadHashConflict: true,
      officialDeltaPending: true,
      lateEventCount: "3",
      unprojectedAdjustmentCount: "2",
    });
    const ch = row("ch", {
      metrics: metrics({
        eventCount: "9",
        cachedInputTokens: "190",
        providerCost: "11.000000000000000000",
        aiuMicros: "2000000",
      }),
      modelIdentityFingerprint: `sha256:${"b".repeat(64)}`,
      costVersionId: "price-current-old",
      aiuVersionId: "aiu-current-old",
    });
    const diffs = reconcileSnapshots({
      pgRows: [pg],
      chRows: [ch],
      tolerance,
      watermark: {
        pgEventTime: "2026-07-16T00:10:00.000Z",
        chEventTime: "2026-07-16T00:05:00.000Z",
        chLastSuccessAt: "2026-07-16T00:05:00.000Z",
        now: "2026-07-16T00:07:00.000Z",
      },
    });
    expect(diffs.map((entry) => entry.type)).toEqual(
      expect.arrayContaining([
        "PAYLOAD_HASH_CONFLICT",
        "MODEL_IDENTITY_MISMATCH",
        "PRICE_VERSION_MISMATCH",
        "AIU_RATE_VERSION_MISMATCH",
        "USAGE_NORMALIZATION_MISMATCH",
        "PROVISIONAL_OFFICIAL_DELTA_PENDING",
        "LEDGER_PROJECTION_MISSING",
        "LATE_EVENT",
        "ADJUSTMENT_NOT_PROJECTED",
        "WATERMARK_STALLED",
      ]),
    );
    expect(
      diffs.find((entry) => entry.type === "PROVISIONAL_OFFICIAL_DELTA_PENDING"),
    ).toMatchObject({
      amount: "1.500000000000000000",
      deltaValues: { providerCost: "1.500000000000000000" },
    });
    expect(diffs.find((entry) => entry.type === "LEDGER_PROJECTION_MISSING")).toMatchObject({
      severity: "critical",
      deltaValues: { aiuMicros: "500000" },
    });
  });

  it("classifies an unexplained official cost gap as a ledger projection failure", () => {
    const diffs = reconcileSnapshots({
      pgRows: [row("pg")],
      chRows: [row("ch", { metrics: metrics({ providerCost: "0" }) })],
      tolerance,
    });
    expect(diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "LEDGER_PROJECTION_MISSING", severity: "critical" }),
      ]),
    );
  });
});

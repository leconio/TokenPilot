import { describe, expect, it } from "vitest";

import {
  exportReconciliationDiffsCsv,
  planFreshClickHouseRebuild,
  planReconciliationRun,
  planReplay,
  pseudonymizeReconciliationUser,
} from "../src/index.js";

describe("reconciliation run and replay planning", () => {
  it("forces automatic and large manual runs into asynchronous execution", () => {
    expect(
      planReconciliationRun({
        applicationId: "application-a",
        runType: "hourly",
        rangeStart: "2026-07-16T00:00:00.000Z",
        rangeEnd: "2026-07-16T01:00:00.000Z",
      }),
    ).toMatchObject({ asynchronous: true });
    expect(
      planReconciliationRun({
        applicationId: "application-a",
        runType: "manual",
        rangeStart: "2026-07-16T00:00:00.000Z",
        rangeEnd: "2026-07-16T00:30:00.000Z",
        userId: "user-1",
      }),
    ).toMatchObject({ asynchronous: false, userId: "user-1" });
  });

  it("defaults replay to dry-run and requires reason plus actor for a committed correction", () => {
    const common = {
      replayType: "rerun_provider_cost" as const,
      rangeStart: "2026-07-16T00:00:00.000Z",
      rangeEnd: "2026-07-16T01:00:00.000Z",
      existingProviderCostLedgerEffects: true,
    };
    expect(planReplay(common)).toMatchObject({
      dryRun: true,
      reason: null,
      providerCostCorrection: "replacement_and_reversal",
    });
    expect(() => planReplay({ ...common, dryRun: false })).toThrow(/reason/u);
    expect(
      planReplay({
        ...common,
        dryRun: false,
        reason: "repair official projection",
        requestedBy: "admin-1",
      }),
    ).toMatchObject({ dryRun: false, requestedBy: "admin-1" });
  });

  it("never lets ordinary replay charge an interval where AIU was disabled", () => {
    expect(() =>
      planReplay({
        replayType: "rerun_aiu_observe",
        rangeStart: "2026-07-01T00:00:00.000Z",
        rangeEnd: "2026-07-02T00:00:00.000Z",
        wouldCreateAiuLedger: true,
        aiuEnabledIntervals: [],
      }),
    ).toThrow(/cannot charge historical/u);
    expect(
      planReplay({
        replayType: "rerun_aiu_observe",
        rangeStart: "2026-07-01T00:00:00.000Z",
        rangeEnd: "2026-07-02T00:00:00.000Z",
        wouldCreateAiuLedger: true,
        existingAiuLedgerEffects: true,
        aiuEnabledIntervals: [
          { start: "2026-07-01T00:00:00.000Z", end: "2026-08-01T00:00:00.000Z" },
        ],
      }),
    ).toMatchObject({ historicalAiuChargeAllowed: true, aiuCorrection: "ledger_adjustment" });
  });
});

describe("safe ClickHouse rebuild and exports", () => {
  it("plans a current-schema rebuild without old table generations", () => {
    expect(
      planFreshClickHouseRebuild({
        rebuildId: "rebuild-20260716",
        database: "ai_control_plane",
      }),
    ).toEqual({
      rebuildId: "rebuild-20260716",
      database: "ai_control_plane",
      steps: [
        "clear_isolated_database",
        "create_current_schema",
        "replay_postgresql_outbox",
        "verify_current_projection",
      ],
    });
    expect(() =>
      planFreshClickHouseRebuild({
        rebuildId: "unsafe",
        database: "usage; DROP DATABASE",
      }),
    ).toThrow(/safe ClickHouse identifier/u);
  });

  it("pseudonymizes user ids and CSV-escapes exported explanations", () => {
    const secret = "reconciliation-test-secret-at-least-thirty-two-bytes";
    expect(pseudonymizeReconciliationUser("user@example.com", secret)).toMatch(
      /^user_hmac:[0-9a-f]{64}$/u,
    );
    const csv = exportReconciliationDiffsCsv([
      {
        type: "WATERMARK_STALLED",
        severity: "critical",
        dimensions: null,
        count: "1",
        amount: null,
        pgValues: null,
        chValues: null,
        deltaValues: {},
        sampleEventIds: [],
        explanation: "stalled, retry required",
      },
    ]);
    expect(csv).toContain('"stalled, retry required"');
  });
});

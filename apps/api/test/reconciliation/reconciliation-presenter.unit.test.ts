import { describe, expect, it } from "vitest";

import { reconciliationDiffSchema, reconciliationRunSchema } from "@tokenpilot/contracts";
import { Prisma } from "@tokenpilot/db";

import { presentDiff, presentRun } from "../../src/reconciliation/reconciliation.presenter.js";

describe("reconciliation presenter", () => {
  it("returns the exact current reconciliation run contract", () => {
    const result = presentRun({
      id: "5c143894-d041-4b56-8631-fab9d0e6de70",
      applicationId: "00000000-0000-4000-8000-000000000001",
      runType: "MANUAL",
      rangeStart: new Date("2026-07-16T00:00:00.000Z"),
      rangeEnd: new Date("2026-07-16T01:00:00.000Z"),
      status: "COMPLETED",
      pgWatermark: new Date("2026-07-16T00:59:00.000Z"),
      chWatermark: new Date("2026-07-16T00:59:00.000Z"),
      scopeJson: {},
      summaryJson: {
        event_count: "1",
        input_tokens: "10",
        cached_input_tokens: "0",
        output_tokens: "3",
        provider_cost: "0.1",
        aiu_micros: "100",
        unpriced_count: "0",
        unrated_count: "0",
        diff_count: "1",
      },
      startedBy: "32369bd3-c543-47a4-9eb5-cfdca5a3e2f5",
      startedAt: new Date("2026-07-16T01:00:00.000Z"),
      finishedAt: new Date("2026-07-16T01:00:05.000Z"),
      error: null,
      _count: { diffs: 1 },
    });

    expect(reconciliationRunSchema.safeParse(result)).toMatchObject({ success: true });
    expect(result).not.toHaveProperty("type");
    expect(result).not.toHaveProperty("range_from");
  });

  it("returns the exact current reconciliation difference contract", () => {
    const result = presentDiff({
      id: "32369bd3-c543-47a4-9eb5-cfdca5a3e2f5",
      runId: "5c143894-d041-4b56-8631-fab9d0e6de70",
      diffType: "CH_MISSING",
      severity: "ERROR",
      dimensionsJson: {
        application_id: "00000000-0000-4000-8000-000000000001",
        granularity: "hour",
        time_bucket: "2026-07-16T00:00:00.000Z",
        virtual_model: "text.fast",
        model_id: "model-1",
        request_model: "openai-primary",
        provider: "openai",
        user_id: null,
      },
      pgValuesJson: { event_count: "1" },
      chValuesJson: null,
      deltaValuesJson: {},
      sampleEventIdsJson: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"],
      differenceCount: 1n,
      amount: new Prisma.Decimal("0.1"),
      explanation: "The current ClickHouse projection is missing an official event.",
      status: "OPEN",
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      createdAt: new Date("2026-07-16T01:00:05.000Z"),
    });

    const parsed = reconciliationDiffSchema.safeParse(result);
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.issues, null, 2));
    }
    expect(parsed.success).toBe(true);
    expect(result).not.toHaveProperty("pg_value");
    expect(result).not.toHaveProperty("sample_ids");
  });
});

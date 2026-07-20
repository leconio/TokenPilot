import { describe, expect, it } from "vitest";

import { replayTypeForDiff } from "../../src/reconciliation/reconciliation.service.js";

describe("reconciliation replay routing", () => {
  it("reprojects missing ClickHouse ledger facts instead of rebuilding PostgreSQL quota", () => {
    expect(replayTypeForDiff("LEDGER_PROJECTION_MISSING")).toBe("reproject_to_clickhouse");
    expect(replayTypeForDiff("CH_MISSING")).toBe("reproject_to_clickhouse");
  });

  it("requires a fresh ClickHouse rebuild for normalization or duplicate projections", () => {
    expect(() => replayTypeForDiff("USAGE_NORMALIZATION_MISMATCH")).toThrow(/fresh ClickHouse/u);
    expect(() => replayTypeForDiff("DUPLICATE_PROJECTION")).toThrow(/fresh ClickHouse/u);
  });
});

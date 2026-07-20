import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { reconciliationDiffSchema, reconciliationRunSchema } from "../src/reconciliation.js";

const fixtures = new URL("../../../fixtures/contracts/current/", import.meta.url);

async function loadFixture(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(relativePath, fixtures), "utf8"));
}

describe("ReconciliationRun", () => {
  it("accepts the canonical bounded run fixture", async () => {
    expect(
      reconciliationRunSchema.safeParse(await loadFixture("valid/reconciliation-run.json")).success,
    ).toBe(true);
  });

  it("enforces range and terminal-state timestamps", async () => {
    const fixture = (await loadFixture("valid/reconciliation-run.json")) as Record<string, unknown>;
    expect(
      reconciliationRunSchema.safeParse({
        ...fixture,
        range_end: fixture.range_start,
      }).success,
    ).toBe(false);
    expect(
      reconciliationRunSchema.safeParse({
        ...fixture,
        status: "failed",
        error: null,
      }).success,
    ).toBe(false);
    expect(
      reconciliationRunSchema.safeParse({
        ...fixture,
        status: "running",
        finished_at: fixture.finished_at,
      }).success,
    ).toBe(false);
  });

  it("accepts explicit unknown run enums without assigning business meaning", async () => {
    const fixture = (await loadFixture("valid/reconciliation-run.json")) as Record<string, unknown>;
    expect(
      reconciliationRunSchema.safeParse({
        ...fixture,
        run_type: "unknown",
        status: "unknown",
      }).success,
    ).toBe(true);
  });
});

describe("ReconciliationDiff", () => {
  it("accepts the canonical strict dimensions and metric maps", async () => {
    expect(
      reconciliationDiffSchema.safeParse(await loadFixture("valid/reconciliation-diff.json"))
        .success,
    ).toBe(true);
  });

  it("rejects ungoverned dimensions and metric-map fields", async () => {
    expect(
      reconciliationDiffSchema.safeParse(
        await loadFixture("invalid/reconciliation-diff-extra-dimension.json"),
      ).success,
    ).toBe(false);

    const fixture = (await loadFixture("valid/reconciliation-diff.json")) as Record<
      string,
      unknown
    >;
    expect(
      reconciliationDiffSchema.safeParse({
        ...fixture,
        delta_values: { event_count: "-5", arbitrary_amount: "100" },
      }).success,
    ).toBe(false);
  });

  it("accepts signed deltas and rejects signed-int64 overflow", async () => {
    expect(
      reconciliationDiffSchema.safeParse(
        await loadFixture("invalid/reconciliation-diff-int64-overflow.json"),
      ).success,
    ).toBe(false);

    const fixture = (await loadFixture("valid/reconciliation-diff.json")) as Record<
      string,
      unknown
    >;
    expect(
      reconciliationDiffSchema.safeParse({
        ...fixture,
        delta_values: {
          event_count: "-9223372036854775808",
          provider_cost: "-0.000001",
          aiu_micros: "9223372036854775807",
        },
      }).success,
    ).toBe(true);
  });

  it("requires at least one source map and resolution evidence for closed diffs", async () => {
    const fixture = (await loadFixture("valid/reconciliation-diff.json")) as Record<
      string,
      unknown
    >;
    expect(
      reconciliationDiffSchema.safeParse({
        ...fixture,
        pg_values: null,
        ch_values: null,
      }).success,
    ).toBe(false);
    expect(
      reconciliationDiffSchema.safeParse({
        ...fixture,
        status: "resolved",
        resolution: null,
        resolved_by: null,
        resolved_at: null,
      }).success,
    ).toBe(false);
    expect(
      reconciliationDiffSchema.safeParse({
        ...fixture,
        status: "resolved",
        resolution: "Reprojected the missing official rows.",
        resolved_by: "admin-1",
        resolved_at: "2026-07-16T01:05:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("represents a stalled watermark without inventing aggregate metrics", async () => {
    const fixture = (await loadFixture("valid/reconciliation-diff.json")) as Record<
      string,
      unknown
    >;
    expect(
      reconciliationDiffSchema.safeParse({
        ...fixture,
        diff_type: "WATERMARK_STALLED",
        dimensions: null,
        pg_values: null,
        ch_values: null,
        delta_values: {},
        count: "1",
        amount: null,
        explanation: "ClickHouse has not advanced within the configured interval.",
      }).success,
    ).toBe(true);
  });

  it("limits samples to 100 globally valid event IDs", async () => {
    const fixture = (await loadFixture("valid/reconciliation-diff.json")) as Record<
      string,
      unknown
    >;
    const sampleEventIds = Array.from(
      { length: 101 },
      (_, index) => `00000000-0000-7000-8000-${index.toString().padStart(12, "0")}`,
    );
    expect(
      reconciliationDiffSchema.safeParse({ ...fixture, sample_event_ids: sampleEventIds }).success,
    ).toBe(false);
  });

  it("accepts unknown diff enums explicitly", async () => {
    const fixture = (await loadFixture("valid/reconciliation-diff.json")) as Record<
      string,
      unknown
    >;
    const dimensions = fixture.dimensions as Record<string, unknown>;
    expect(
      reconciliationDiffSchema.safeParse({
        ...fixture,
        diff_type: "unknown",
        severity: "unknown",
        status: "unknown",
        dimensions: { ...dimensions, granularity: "unknown" },
      }).success,
    ).toBe(true);
  });
});

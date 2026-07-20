import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { reportEnvelopeSchema } from "../src/report-envelope.js";

const fixtures = new URL("../../../fixtures/contracts/current/", import.meta.url);

async function loadFixture(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(relativePath, fixtures), "utf8"));
}

describe("ReportEnvelope", () => {
  it("accepts only the canonical ClickHouse analytics envelope", async () => {
    expect(
      reportEnvelopeSchema.safeParse(await loadFixture("valid/report-envelope-analytics.json"))
        .success,
    ).toBe(true);
    expect(
      reportEnvelopeSchema.safeParse(await loadFixture("invalid/report-envelope-postgresql.json"))
        .success,
    ).toBe(false);
  });

  it("rejects retired source and provisional metadata", async () => {
    expect(
      reportEnvelopeSchema.safeParse(
        await loadFixture("invalid/report-envelope-unsupported-source.json"),
      ).success,
    ).toBe(false);
  });

  it("rejects strict extra fields at envelope and range boundaries", async () => {
    expect(
      reportEnvelopeSchema.safeParse(await loadFixture("invalid/report-envelope-extra-field.json"))
        .success,
    ).toBe(false);

    const fixture = (await loadFixture("valid/report-envelope-analytics.json")) as Record<
      string,
      unknown
    >;
    const range = fixture.range as Record<string, unknown>;
    expect(
      reportEnvelopeSchema.safeParse({
        ...fixture,
        range: { ...range, unsafe_dimension_sql: "subject_id || secret" },
      }).success,
    ).toBe(false);
  });

  it("rejects reversed ranges and requires data", async () => {
    const fixture = (await loadFixture("valid/report-envelope-analytics.json")) as Record<
      string,
      unknown
    >;
    const range = fixture.range as Record<string, unknown>;
    expect(
      reportEnvelopeSchema.safeParse({
        ...fixture,
        range: { ...range, from: range.to, to: range.from },
      }).success,
    ).toBe(false);

    const withoutData = { ...fixture };
    delete withoutData.data;
    expect(reportEnvelopeSchema.safeParse(withoutData).success).toBe(false);
  });

  it("intentionally permits any JSON-shaped report data without weakening the envelope", async () => {
    const fixture = (await loadFixture("valid/report-envelope-analytics.json")) as Record<
      string,
      unknown
    >;
    for (const data of [null, "summary", [1, 2, 3], { rows: [{ value: "1" }] }]) {
      expect(reportEnvelopeSchema.safeParse({ ...fixture, data }).success).toBe(true);
    }
  });

  it("rejects retired source metadata and permits a missing ClickHouse watermark", () => {
    expect(
      reportEnvelopeSchema.safeParse({
        source: "official",
        watermark: null,
        lag_seconds: null,
        range: null,
        data: {},
      }).success,
    ).toBe(false);
    expect(
      reportEnvelopeSchema.safeParse({
        watermark: null,
        lag_seconds: null,
        range: null,
        data: {},
      }).success,
    ).toBe(true);
  });
});

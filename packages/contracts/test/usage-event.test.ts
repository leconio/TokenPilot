import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  normalizationWarningValues,
  normalizedUsageSchema,
  usageBatchSchema,
  usageEventSchema,
  usageLineSchema,
  usageSourceTypeValues,
  usageUnitForType,
  usageUnitValues,
  usageUnitsByType,
} from "../src/usage-event.js";
import { usageConfidenceValues, usageTypeValues } from "../src/primitives.js";

const fixtures = new URL("../../../fixtures/contracts/current/", import.meta.url);

async function loadFixture(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(relativePath, fixtures), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("UsageEvent", () => {
  it("has the exact schema ID and accepts the canonical raw event", async () => {
    expect(usageEventSchema.meta()?.id).toBe("UsageEvent");
    expect(usageEventSchema.safeParse(await loadFixture("valid/usage-event.json")).success).toBe(
      true,
    );
  });

  it("requires an application user ID on every model usage event", async () => {
    const fixture = await loadFixture("valid/usage-event.json");
    delete fixture.user;
    expect(usageEventSchema.safeParse(fixture).success).toBe(false);
  });

  it("keeps raw buckets optional without injecting custom-unit defaults", async () => {
    const fixture = await loadFixture("valid/usage-event.json");
    const usage = { ...(fixture.usage as Record<string, unknown>) };
    delete usage.custom_units;
    const parsed = usageEventSchema.parse({ ...fixture, usage });
    expect("custom_units" in parsed.usage).toBe(false);
  });

  it("requires at least one bucket and unique custom unit keys", async () => {
    const fixture = await loadFixture("valid/usage-event.json");
    expect(usageEventSchema.safeParse({ ...fixture, usage: {} }).success).toBe(false);

    const usage = fixture.usage as Record<string, unknown>;
    const customUnits = usage.custom_units as unknown[];
    expect(
      usageEventSchema.safeParse({
        ...fixture,
        usage: { ...usage, custom_units: [customUnits[0], customUnits[0]] },
      }).success,
    ).toBe(false);
  });

  it("requires decimal strings and complete custom usage metadata", async () => {
    const fixture = await loadFixture("valid/usage-event.json");
    const usage = fixture.usage as Record<string, unknown>;
    expect(
      usageEventSchema.safeParse({
        ...fixture,
        usage: { ...usage, output_tokens: 1200 },
      }).success,
    ).toBe(false);
    expect(
      usageEventSchema.safeParse({
        ...fixture,
        usage: {
          ...usage,
          custom_units: [{ unit_key: "gpu_millisecond", quantity: "1" }],
        },
      }).success,
    ).toBe(false);
  });

  it("allows nullable routing and request context while rejecting unknown fields", async () => {
    const fixture = await loadFixture("valid/usage-event.json");
    const request = fixture.request as Record<string, unknown>;
    expect(
      usageEventSchema.safeParse({
        ...fixture,
        request: {
          ...request,
          operation_id: null,
          parent_request_id: null,
          session_id: null,
          conversation_id: null,
          trace_id: null,
        },
        route: null,
      }).success,
    ).toBe(true);
    expect(usageEventSchema.safeParse({ ...fixture, prompt: "secret" }).success).toBe(false);
  });

  it("does not materialize analytics dimensions and uses schema version 2.0 only", async () => {
    const fixture = await loadFixture("valid/usage-event.json");
    const withoutAnalytics = { ...fixture };
    delete withoutAnalytics.analytics_dimensions;
    expect(usageEventSchema.safeParse(withoutAnalytics).success).toBe(false);
    expect(usageEventSchema.safeParse({ ...fixture, schema_version: "2.1" }).success).toBe(false);
  });
});

describe("UsageBatch", () => {
  it("requires batch identity and time and accepts 1..1000 events", async () => {
    const batch = await loadFixture("valid/usage-batch.json");
    expect(usageBatchSchema.meta()?.id).toBe("UsageBatch");
    expect(usageBatchSchema.safeParse(batch).success).toBe(true);
    expect(usageBatchSchema.safeParse({ ...batch, events: [] }).success).toBe(false);
    expect(usageBatchSchema.safeParse({ ...batch, batch_id: undefined }).success).toBe(false);
    expect(usageBatchSchema.safeParse({ ...batch, sent_at: undefined }).success).toBe(false);
  });

  it("rejects duplicate event IDs within one batch", async () => {
    const event = await loadFixture("valid/usage-event.json");
    expect(
      usageBatchSchema.safeParse({
        schema_version: "2.0",
        batch_id: "batch_01JTEST",
        sent_at: "2026-07-15T12:35:00.000Z",
        events: [event, structuredClone(event)],
      }).success,
    ).toBe(false);
  });
});

describe("NormalizedUsage", () => {
  it("has the exact schema ID and accepts the canonical normalized fixture", async () => {
    expect(normalizedUsageSchema.meta()?.id).toBe("NormalizedUsage");
    expect(
      normalizedUsageSchema.safeParse(await loadFixture("valid/usage-normalized.json")).success,
    ).toBe(true);
  });

  it("requires custom unit keys and forbids them on every non-custom line", async () => {
    expect(
      usageLineSchema.safeParse(
        await loadFixture("invalid/usage-custom-line-missing-unit-key.json"),
      ).success,
    ).toBe(false);
    expect(
      usageLineSchema.safeParse(await loadFixture("invalid/usage-standard-line-with-unit-key.json"))
        .success,
    ).toBe(false);
  });

  it("enforces the expected physical unit for every standard usage type", () => {
    expect(usageUnitForType("custom_unit")).toBe("custom");
    expect(Object.keys(usageUnitsByType)).toEqual(usageTypeValues);
    for (const [usage_type, unit] of Object.entries(usageUnitsByType)) {
      if (usage_type === "custom_unit") continue;
      const line = {
        usage_type,
        quantity: "1",
        unit,
        source_path: "usage.value",
        is_estimated: false,
        confidence: "estimated",
      };
      expect(usageLineSchema.safeParse(line).success).toBe(true);
      expect(usageLineSchema.safeParse({ ...line, unit: "custom" }).success).toBe(false);
    }
  });

  it("rejects duplicate standard buckets and duplicate custom keys", async () => {
    const fixture = await loadFixture("valid/usage-normalized.json");
    const lines = fixture.usage_lines as Array<Record<string, unknown>>;
    expect(
      normalizedUsageSchema.safeParse({ ...fixture, usage_lines: [lines[0], lines[0]] }).success,
    ).toBe(false);
    expect(
      normalizedUsageSchema.safeParse({ ...fixture, usage_lines: [lines[1], lines[1]] }).success,
    ).toBe(false);
  });

  it("keeps warning and missing-field evidence inside normalization", async () => {
    const fixture = await loadFixture("valid/usage-normalized.json");
    expect(
      normalizedUsageSchema.safeParse({
        ...fixture,
        warnings: ["unknown"],
      }).success,
    ).toBe(false);
    const normalization = fixture.normalization as Record<string, unknown>;
    expect(
      normalizedUsageSchema.safeParse({
        ...fixture,
        normalization: {
          ...normalization,
          missing_usage_fields: ["input_video_seconds", "input_video_seconds"],
        },
      }).success,
    ).toBe(false);
  });

  it("exposes explicit unknown members on every public enum", async () => {
    const fixture = await loadFixture("valid/usage-normalized.json");
    const source = fixture.source as Record<string, unknown>;
    const normalization = fixture.normalization as Record<string, unknown>;
    const lines = fixture.usage_lines as Array<Record<string, unknown>>;
    const baseLine = lines[0]!;

    for (const type of usageSourceTypeValues) {
      expect(
        normalizedUsageSchema.safeParse({ ...fixture, source: { ...source, type } }).success,
      ).toBe(true);
    }
    for (const confidence of usageConfidenceValues) {
      expect(usageLineSchema.safeParse({ ...baseLine, confidence }).success).toBe(true);
    }
    expect(usageTypeValues).toContain("unknown");
    expect(usageUnitValues).toContain("unknown");
    expect(normalizationWarningValues).toContain("unknown");
    expect(
      normalizedUsageSchema.safeParse({
        ...fixture,
        normalization: { ...normalization, warnings: ["unknown"] },
      }).success,
    ).toBe(true);
  });
});

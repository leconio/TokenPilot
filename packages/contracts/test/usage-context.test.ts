import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  analyticsDimensionsSchema,
  MAX_DIMENSION_COUNT,
  MAX_DIMENSION_UTF8_BYTES,
  reservedDimensionKeys,
} from "../src/usage-context.js";

const fixtures = new URL("../../../fixtures/contracts/current/", import.meta.url);

async function loadFixture(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(relativePath, fixtures), "utf8"));
}

describe("AnalyticsDimensions", () => {
  it("accepts the canonical custom-dimension fixture", async () => {
    expect(analyticsDimensionsSchema.meta()?.id).toBe("AnalyticsDimensions");
    expect(analyticsDimensionsSchema.meta()?.maxProperties).toBe(MAX_DIMENSION_COUNT);
    expect(
      analyticsDimensionsSchema.safeParse(
        await loadFixture("valid/usage-analytics-dimensions.json"),
      ).success,
    ).toBe(true);
  });

  it("rejects system fields, cp_ keys, invalid values, and too many fields", () => {
    expect(analyticsDimensionsSchema.safeParse({ cp_secret: "no" }).success).toBe(false);
    for (const key of reservedDimensionKeys) {
      expect(analyticsDimensionsSchema.safeParse({ [key]: "shadow" }).success).toBe(false);
    }
    expect(analyticsDimensionsSchema.safeParse({ InvalidKey: "no" }).success).toBe(false);
    expect(analyticsDimensionsSchema.safeParse({ valid_key: null }).success).toBe(false);
    expect(
      analyticsDimensionsSchema.safeParse(
        Object.fromEntries(
          Array.from({ length: MAX_DIMENSION_COUNT + 1 }, (_, index) => [`key_${index}`, true]),
        ),
      ).success,
    ).toBe(false);
  });

  it("counts the serialized map in UTF-8 bytes and never injects defaults", () => {
    const withinLimit = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`key_${index}`, "界".repeat(256)]),
    );
    const overLimit = { ...withinLimit, key_10: "界".repeat(256) };
    expect(Buffer.byteLength(JSON.stringify(withinLimit), "utf8")).toBeLessThanOrEqual(
      MAX_DIMENSION_UTF8_BYTES,
    );
    expect(Buffer.byteLength(JSON.stringify(overLimit), "utf8")).toBeGreaterThan(
      MAX_DIMENSION_UTF8_BYTES,
    );
    expect(analyticsDimensionsSchema.safeParse(withinLimit).success).toBe(true);
    expect(analyticsDimensionsSchema.safeParse(overLimit).success).toBe(false);
    expect(analyticsDimensionsSchema.parse({ client: "ios" })).toEqual({ client: "ios" });
  });
});

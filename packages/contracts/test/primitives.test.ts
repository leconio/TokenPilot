import { describe, expect, it } from "vitest";

import { compareUtcDateTimes } from "../src/common.js";
import {
  decimal38_18Schema,
  decimal38_9Schema,
  eventIdSchema,
  microAiuStringSchema,
  opaqueIdSchema,
  signedDecimal38_18Schema,
  signedMicroAiuStringSchema,
  usageTypeSchema,
  utcTimestampSchema,
} from "../src/primitives.js";

describe("Contract primitives", () => {
  it("accepts canonical event IDs while allowing broader opaque resource IDs", () => {
    expect(eventIdSchema.safeParse("01J00000000000000000000000").success).toBe(true);
    expect(eventIdSchema.safeParse("018f47fb-764a-7cc0-98ed-12b5a6cd8910").success).toBe(true);
    expect(eventIdSchema.safeParse("018F47FB-764A-7CC0-98ED-12B5A6CD8910").success).toBe(true);
    expect(eventIdSchema.safeParse("evt_01J00000000000000000000000").success).toBe(false);
    expect(opaqueIdSchema.safeParse("req_01J:attempt@provider").success).toBe(true);
    expect(opaqueIdSchema.safeParse(" id with whitespace ").success).toBe(false);
  });

  it.each(["0", "1", "0.000001", "99999999999999999999.123456789012345678"])(
    "accepts canonical numeric(38,18) value %s",
    (value) => {
      expect(decimal38_18Schema.safeParse(value).success).toBe(true);
    },
  );

  it.each(["01", "+1", "1e3", "-1", "100000000000000000000", "1.1234567890123456789"])(
    "rejects invalid unsigned money value %s",
    (value) => {
      expect(decimal38_18Schema.safeParse(value).success).toBe(false);
    },
  );

  it("distinguishes signed deltas and positive unit sizes", () => {
    expect(signedDecimal38_18Schema.safeParse("-1.000001").success).toBe(true);
    expect(signedDecimal38_18Schema.safeParse("-0.0063").success).toBe(true);
    expect(signedDecimal38_18Schema.safeParse("-0").success).toBe(false);
    expect(signedDecimal38_18Schema.safeParse("-0.0").success).toBe(false);
    expect(decimal38_9Schema.safeParse("99999999999999999999999999999.123456789").success).toBe(
      true,
    );
    expect(decimal38_9Schema.safeParse("1.1234567890").success).toBe(false);
  });

  it("enforces signed-int64 wire bounds without JSON numbers", () => {
    expect(microAiuStringSchema.safeParse("0").success).toBe(true);
    expect(microAiuStringSchema.safeParse("9223372036854775807").success).toBe(true);
    expect(microAiuStringSchema.safeParse("9223372036854775808").success).toBe(false);
    expect(microAiuStringSchema.safeParse(1).success).toBe(false);

    expect(signedMicroAiuStringSchema.safeParse("-9223372036854775808").success).toBe(true);
    expect(signedMicroAiuStringSchema.safeParse("9223372036854775807").success).toBe(true);
    expect(signedMicroAiuStringSchema.safeParse("-9223372036854775809").success).toBe(false);
    expect(signedMicroAiuStringSchema.safeParse("-0").success).toBe(false);
  });

  it("validates real UTC calendar instants and compares all nine fractional digits", () => {
    expect(utcTimestampSchema.safeParse("2024-02-29T23:59:59.123456789Z").success).toBe(true);
    for (const value of [
      "0000-01-01T00:00:00Z",
      "2026-02-30T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T00:00:60Z",
      "٢٠٢٦-٠١-٠١T٠٠:٠٠:٠٠Z",
      "2٠26-01-01T00:00:00Z",
    ]) {
      expect(utcTimestampSchema.safeParse(value).success).toBe(false);
    }

    expect(
      compareUtcDateTimes("2026-01-01T00:00:00.000000001Z", "2026-01-01T00:00:00.000000002Z"),
    ).toBeLessThan(0);
    expect(compareUtcDateTimes("2026-01-01T00:00:00.1Z", "2026-01-01T00:00:00.100000000Z")).toBe(0);
  });

  it("uses an explicit unknown usage type rather than accepting arbitrary strings", () => {
    expect(usageTypeSchema.safeParse("unknown").success).toBe(true);
    expect(usageTypeSchema.safeParse("future_unmapped_value").success).toBe(false);
  });
});

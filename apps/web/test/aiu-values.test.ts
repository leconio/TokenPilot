import { describe, expect, it } from "vitest";

import {
  aiuUsagePercentage,
  effectiveLimitAiuMicros,
  formatAiuMicros,
  parseAiuUnits,
} from "../features/control-plane/quota/aiu-values";

describe("AIU display values", () => {
  it("converts user-facing AIU values to integer micros", () => {
    expect(parseAiuUnits("125")).toBe("125000000");
    expect(parseAiuUnits("0.000001")).toBe("1");
    expect(() => parseAiuUnits("1.0000001")).toThrow(/6 位小数/u);
  });

  it("formats micros without exposing the storage unit", () => {
    expect(formatAiuMicros("125500000")).toBe("125.5 AIU");
    expect(formatAiuMicros("-1")).toBe("−0.000001 AIU");
    expect(formatAiuMicros(undefined)).toBe("-");
  });

  it("includes adjustments in the displayed allowance and usage ratio", () => {
    const input = {
      limitAiuMicros: "100000000",
      adjustmentAiuMicros: "20000000",
      consumedAiuMicros: "30000000",
    };
    expect(effectiveLimitAiuMicros(input)).toBe("120000000");
    expect(aiuUsagePercentage(input)).toBe("25.0%");
  });
});

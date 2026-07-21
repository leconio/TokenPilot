import { describe, expect, it } from "vitest";

import { saveModelCostRulesSchema } from "../src/model-cost.js";

describe("model cost rules", () => {
  it("accepts ordered conditions with fixed and per-usage amounts", () => {
    expect(
      saveModelCostRulesSchema.parse({
        rules: [
          {
            name: "Enterprise voice",
            match: "all",
            conditions: [
              { kind: "builtin", field: "provider", operator: "equals", values: ["openai"] },
              {
                kind: "property",
                scope: "event",
                key: "voice_seconds",
                operator: "greater_than",
                values: [10],
              },
            ],
            fixed_amount: "0.01",
            rates: [
              { usage_type: "output_token", amount_per_unit: "0.00001" },
              {
                usage_type: "custom_unit",
                unit_key: "tool_call",
                amount_per_unit: "0.005",
              },
            ],
          },
        ],
      }),
    ).toMatchObject({ rules: [{ name: "Enterprise voice", match: "all" }] });
  });

  it("allows no fallback rules when reported cost is required", () => {
    expect(saveModelCostRulesSchema.parse({ rules: [] })).toEqual({ rules: [] });
  });

  it("rejects post-rating fields, duplicate usage amounts, and empty calculations", () => {
    expect(
      saveModelCostRulesSchema.safeParse({
        rules: [
          {
            name: "Invalid field",
            match: "all",
            conditions: [
              { kind: "builtin", field: "cost_status", operator: "equals", values: ["official"] },
            ],
            fixed_amount: "1",
            rates: [],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      saveModelCostRulesSchema.safeParse({
        rules: [
          {
            name: "Duplicate",
            match: "all",
            conditions: [],
            rates: [
              { usage_type: "output_token", amount_per_unit: "1" },
              { usage_type: "output_token", amount_per_unit: "2" },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      saveModelCostRulesSchema.safeParse({
        rules: [{ name: "Empty", match: "all", conditions: [], rates: [] }],
      }).success,
    ).toBe(false);
  });
});

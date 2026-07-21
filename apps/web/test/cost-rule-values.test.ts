import { describe, expect, it } from "vitest";

import {
  costRuleComplete,
  costRulesRequestBody,
  editableCostRules,
  emptyCostRule,
} from "../features/models/cost-rule-values";

describe("model cost rule forms", () => {
  it("hydrates standard, custom, fixed, and conditional values", () => {
    const [rule] = editableCostRules([
      {
        id: "rule-1",
        name: "生产流量",
        priority: 0,
        match: "all",
        conditions: [
          {
            kind: "property",
            scope: "event",
            key: "channel",
            data_type: "ENUM",
            operator: "equals",
            values: ["production"],
          },
        ],
        fixed_amount: "0.01",
        rates: [
          { usage_type: "uncached_input_token", amount_per_unit: "0.0000025" },
          {
            usage_type: "custom_unit",
            unit_key: "tool_call",
            amount_per_unit: "0.005",
          },
        ],
      },
    ]);

    expect(rule).toMatchObject({
      name: "生产流量",
      fixedAmount: "0.01",
      amounts: { uncached_input_token: "0.0000025" },
      customAmounts: [{ unit_key: "tool_call", amount_per_unit: "0.005" }],
      conditions: [expect.objectContaining({ data_type: "ENUM", values: ["production"] })],
    });
    expect(costRuleComplete(rule!)).toBe(true);
  });

  it("strips UI-only condition fields and omits empty amounts", () => {
    const rule = emptyCostRule(0);
    const body = costRulesRequestBody([
      {
        ...rule,
        name: "默认规则",
        amounts: { ...rule.amounts, output_token: "0.00001" },
        conditions: [
          {
            id: "condition-1",
            kind: "property",
            scope: "user",
            key: "tier",
            data_type: "TEXT",
            operator: "equals",
            values: ["pro"],
          },
        ],
      },
    ]);

    expect(body.rules[0]).toEqual({
      name: "默认规则",
      match: "all",
      conditions: [
        {
          kind: "property",
          scope: "user",
          key: "tier",
          operator: "equals",
          values: ["pro"],
        },
      ],
      fixed_amount: null,
      rates: [{ usage_type: "output_token", amount_per_unit: "0.00001" }],
    });
  });

  it("requires a name and at least one calculation amount", () => {
    const rule = emptyCostRule(0);
    expect(costRuleComplete(rule)).toBe(false);
    expect(costRuleComplete({ ...rule, fixedAmount: "0" })).toBe(true);
  });
});

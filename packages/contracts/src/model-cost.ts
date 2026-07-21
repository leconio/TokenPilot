import { z } from "zod";

import { reportFilterConditionSchema } from "./report-query.js";
import {
  boundedUnicodeStringSchema,
  decimal38_18Schema,
  unitKeySchema,
  usageTypeSchema,
} from "./primitives.js";

export const modelCostBuiltInFieldValues = [
  "event_id",
  "request_id",
  "attempt_id",
  "operation_id",
  "session_id",
  "conversation_id",
  "user_id",
  "display_user",
  "application_version",
  "sdk_version",
  "connector_version",
  "config_version",
  "virtual_model",
  "model_id",
  "connection_id",
  "connection_driver",
  "request_model",
  "provider",
  "status",
  "schema_version",
  "route_reason",
  "latency_ms",
] as const;

const modelCostBuiltInFields = new Set<string>(modelCostBuiltInFieldValues);

export const modelCostConditionSchema = reportFilterConditionSchema.refine(
  (condition) => condition.kind === "property" || modelCostBuiltInFields.has(condition.field),
  "This field is not available while model cost is being calculated",
);

export const modelCostRateSchema = z
  .strictObject({
    usage_type: usageTypeSchema,
    unit_key: unitKeySchema.optional(),
    amount_per_unit: decimal38_18Schema,
  })
  .superRefine((rate, context) => {
    if (rate.usage_type === "custom_unit" && rate.unit_key === undefined) {
      context.addIssue({
        code: "custom",
        path: ["unit_key"],
        message: "A custom usage amount requires unit_key",
      });
    }
    if (rate.usage_type !== "custom_unit" && rate.unit_key !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["unit_key"],
        message: "unit_key is only available for custom usage",
      });
    }
  });

export const modelCostRuleSchema = z
  .strictObject({
    name: boundedUnicodeStringSchema({ minLength: 1, maxLength: 120 }),
    match: z.enum(["all", "any"]).default("all"),
    conditions: z.array(modelCostConditionSchema).max(32).default([]),
    fixed_amount: decimal38_18Schema.nullable().optional(),
    rates: z.array(modelCostRateSchema).max(64).default([]),
  })
  .superRefine((rule, context) => {
    if (rule.fixed_amount === null || rule.fixed_amount === undefined) {
      if (rule.rates.length === 0) {
        context.addIssue({ code: "custom", message: "Set a fixed amount or a usage amount" });
      }
    }
    const identities = rule.rates.map((rate) => `${rate.usage_type}\u0000${rate.unit_key ?? ""}`);
    if (new Set(identities).size !== identities.length) {
      context.addIssue({
        code: "custom",
        path: ["rates"],
        message: "Usage amounts must be unique within a cost rule",
      });
    }
  });

export const saveModelCostRulesSchema = z.strictObject({
  rules: z.array(modelCostRuleSchema).max(64),
});

export type ModelCostCondition = z.infer<typeof modelCostConditionSchema>;
export type ModelCostRate = z.infer<typeof modelCostRateSchema>;
export type ModelCostRule = z.infer<typeof modelCostRuleSchema>;
export type SaveModelCostRules = z.infer<typeof saveModelCostRulesSchema>;

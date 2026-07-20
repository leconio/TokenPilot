import { z } from "zod";

import { compareUtcDateTimes } from "./common.js";
import { boundedUnicodeStringSchema, utcTimestampSchema } from "./primitives.js";

export const reportGroupDimensionValues = [
  "model_id",
  "request_model",
  "virtual_model",
  "connection_id",
  "connection_driver",
  "user_id",
  "user_tag",
  "provider",
  "route_reason",
  "time",
  "hour",
  "day",
  "week",
  "month",
  "property",
] as const;
export const reportGroupDimensionSchema = z.enum(reportGroupDimensionValues);

export const reportMetricValues = [
  "requests",
  "tokens",
  "unique_users",
  "success_rate",
  "average_latency",
  "provider_cost",
  "aiu",
] as const;
export const reportMetricSchema = z.enum(reportMetricValues);
export const reportTimeGrainValues = ["hour", "day", "week", "month"] as const;
export const reportTimeGrainSchema = z.enum(reportTimeGrainValues);

export const reportBuiltInFieldValues = [
  "event_id",
  "request_id",
  "attempt_id",
  "operation_id",
  "session_id",
  "conversation_id",
  "user_id",
  "display_user",
  "user_tag",
  "user_group",
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
  "cost_status",
  "aiu_status",
  "quota_status",
] as const;
export const reportBuiltInFieldSchema = z.enum(reportBuiltInFieldValues);

export const reportFilterOperatorValues = [
  "equals",
  "not_equals",
  "contains",
  "starts_with",
  "greater_than",
  "greater_or_equal",
  "less_than",
  "less_or_equal",
  "between",
  "one_of",
  "contains_any",
  "contains_all",
  "is_set",
  "is_not_set",
] as const;
export const reportFilterOperatorSchema = z.enum(reportFilterOperatorValues);

const filterValueSchema = z.union([
  boundedUnicodeStringSchema({ minLength: 1, maxLength: 2_048 }),
  z.number().finite().safe(),
  z.boolean(),
]);
const filterValuesSchema = z.array(filterValueSchema).max(32);
const propertyKeySchema = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/u);
export const reportPropertyGroupSchema = z.strictObject({
  scope: z.enum(["event", "user"]),
  key: propertyKeySchema,
});

const builtInConditionSchema = z.strictObject({
  kind: z.literal("builtin"),
  field: reportBuiltInFieldSchema,
  operator: reportFilterOperatorSchema,
  values: filterValuesSchema.default([]),
});
const propertyConditionSchema = z.strictObject({
  kind: z.literal("property"),
  scope: z.enum(["event", "user"]),
  key: propertyKeySchema,
  operator: reportFilterOperatorSchema,
  values: filterValuesSchema.default([]),
});

const textConditionOperators = new Set([
  "equals",
  "not_equals",
  "contains",
  "starts_with",
  "one_of",
  "is_set",
  "is_not_set",
]);
const selectionConditionOperators = new Set([
  "equals",
  "not_equals",
  "one_of",
  "is_set",
  "is_not_set",
]);
const exactIdentifierFields = new Set([
  "event_id",
  "request_id",
  "attempt_id",
  "operation_id",
  "session_id",
  "conversation_id",
]);
const numericConditionOperators = new Set([
  "equals",
  "not_equals",
  "greater_than",
  "greater_or_equal",
  "less_than",
  "less_or_equal",
  "between",
  "is_set",
  "is_not_set",
]);

function validateBuiltInCondition(
  condition: z.infer<typeof builtInConditionSchema>,
  context: z.RefinementCtx,
): void {
  const operators =
    condition.field === "latency_ms"
      ? numericConditionOperators
      : exactIdentifierFields.has(condition.field)
        ? selectionConditionOperators
        : [
              "cost_status",
              "aiu_status",
              "quota_status",
              "user_group",
              "user_tag",
              "status",
            ].includes(condition.field)
          ? selectionConditionOperators
          : textConditionOperators;
  if (!operators.has(condition.operator)) {
    context.addIssue({
      code: "custom",
      path: ["operator"],
      message: "The selected comparison is not valid for this field",
    });
  }
  const expectedType = condition.field === "latency_ms" ? "number" : "string";
  if (condition.values.some((value) => typeof value !== expectedType)) {
    context.addIssue({
      code: "custom",
      path: ["values"],
      message: "The filter value does not match the selected field",
    });
  }
  if (
    condition.field === "latency_ms" &&
    condition.operator === "between" &&
    typeof condition.values[0] === "number" &&
    typeof condition.values[1] === "number" &&
    condition.values[0] > condition.values[1]
  ) {
    context.addIssue({
      code: "custom",
      path: ["values"],
      message: "The beginning of a range cannot be greater than its end",
    });
  }
}

export const reportFilterConditionSchema = z
  .discriminatedUnion("kind", [builtInConditionSchema, propertyConditionSchema])
  .superRefine((condition, context) => {
    const count = condition.values.length;
    if (["is_set", "is_not_set"].includes(condition.operator) && count !== 0) {
      context.addIssue({ code: "custom", path: ["values"], message: "This operator has no value" });
    } else if (condition.operator === "between" && count !== 2) {
      context.addIssue({
        code: "custom",
        path: ["values"],
        message: "Between requires two values",
      });
    } else if (!["is_set", "is_not_set", "between"].includes(condition.operator) && count < 1) {
      context.addIssue({ code: "custom", path: ["values"], message: "A filter value is required" });
    }
    if (condition.kind === "builtin") validateBuiltInCondition(condition, context);
  });

export const reportStaticQueryKeys = [
  "from",
  "to",
  "timezone",
  "cursor",
  "page_size",
  "filter_match",
  "conditions",
  "metric",
  "grain",
  "group_dimension",
  "group_property",
] as const;

const textSchema = boundedUnicodeStringSchema({ minLength: 1, maxLength: 512 });
const cursorSchema = boundedUnicodeStringSchema({ minLength: 1, maxLength: 16_384 });
export const reportQuerySchema = z
  .strictObject({
    from: utcTimestampSchema,
    to: utcTimestampSchema,
    timezone: textSchema.default("UTC"),
    cursor: cursorSchema.optional(),
    page_size: z.number().int().min(1).max(200).default(50),
    filter_match: z.enum(["all", "any"]).default("all"),
    conditions: z.array(reportFilterConditionSchema).max(64).default([]),
    metric: reportMetricSchema.default("requests"),
    grain: reportTimeGrainSchema.default("day"),
    group_dimension: reportGroupDimensionSchema.default("request_model"),
    group_property: reportPropertyGroupSchema.optional(),
  })
  .superRefine((query, context) => {
    if (compareUtcDateTimes(query.from, query.to) >= 0) {
      context.addIssue({ code: "custom", path: ["to"], message: "to must be later than from" });
    }
    if (Date.parse(query.to) - Date.parse(query.from) > 366 * 86_400_000) {
      context.addIssue({
        code: "custom",
        path: ["from"],
        message: "Report range cannot exceed 366 days",
      });
    }
    try {
      new Intl.DateTimeFormat("en", { timeZone: query.timezone }).format(new Date(query.to));
    } catch {
      context.addIssue({ code: "custom", path: ["timezone"], message: "Invalid timezone" });
    }
    if (query.group_dimension === "property" && query.group_property === undefined) {
      context.addIssue({
        code: "custom",
        path: ["group_property"],
        message: "A custom field is required for property grouping",
      });
    }
    if (query.group_dimension !== "property" && query.group_property !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["group_property"],
        message: "Custom field grouping requires the property dimension",
      });
    }
  });

export type ReportQuery = z.infer<typeof reportQuerySchema>;
export type ReportFilterCondition = z.infer<typeof reportFilterConditionSchema>;
export type ReportFilterOperator = z.infer<typeof reportFilterOperatorSchema>;
export type ReportGroupDimension = z.infer<typeof reportGroupDimensionSchema>;
export type ReportPropertyGroup = z.infer<typeof reportPropertyGroupSchema>;
export type ReportMetric = z.infer<typeof reportMetricSchema>;
export type ReportTimeGrain = z.infer<typeof reportTimeGrainSchema>;

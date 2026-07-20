import type { ContractParameter, OpenApiSchema } from "../types.js";
import { DATE_TIME, object, POLICY_REASON, query, UUID } from "../schema-helpers.js";

const REPORT_FILTER_QUERY: readonly ContractParameter[] = [
  query("from", DATE_TIME),
  query("to", DATE_TIME),
  query("timezone", { type: "string", minLength: 1, maxLength: 128 }),
  query("filter_match", { type: "string", enum: ["all", "any"] }),
  query(
    "conditions",
    { type: "string", minLength: 2, maxLength: 16_384 },
    false,
    "JSON array of typed built-in or custom-field conditions.",
  ),
  query("metric", {
    type: "string",
    enum: [
      "requests",
      "tokens",
      "unique_users",
      "success_rate",
      "average_latency",
      "provider_cost",
      "aiu",
    ],
  }),
  query("grain", { type: "string", enum: ["hour", "day", "week", "month"] }),
];

const REPORT_GROUP = query("group_dimension", {
  type: "string",
  enum: [
    "model_tag",
    "virtual_model",
    "user_id",
    "provider",
    "route_reason",
    "time",
    "hour",
    "day",
    "week",
    "month",
    "property",
  ],
});

const REPORT_GROUP_PROPERTY = query(
  "group_property",
  { type: "string", minLength: 2, maxLength: 1_024 },
  false,
  "JSON custom-field scope and key when grouping by a custom field.",
);

export const REPORT_QUERY: readonly ContractParameter[] = [
  ...REPORT_FILTER_QUERY,
  query("page_size", { type: "integer", minimum: 1, maximum: 200 }),
];

export const GROUP_REPORT_QUERY: readonly ContractParameter[] = [
  ...REPORT_QUERY,
  query(
    "cursor",
    { type: "string", minLength: 1, maxLength: 16_384 },
    false,
    "Opaque keyset cursor returned by the previous grouped result page.",
  ),
  REPORT_GROUP,
  REPORT_GROUP_PROPERTY,
];

export const USAGE_REPORT_QUERY: readonly ContractParameter[] = [
  ...REPORT_FILTER_QUERY,
  query(
    "cursor",
    { type: "string", minLength: 1, maxLength: 16_384 },
    false,
    "Opaque keyset cursor returned by the previous Usage page.",
  ),
  query("page_size", { type: "integer", minimum: 1, maximum: 200 }),
];

export const DLQ_REPLAY = object(["dead_letter_id", "reason"], {
  dead_letter_id: UUID,
  reason: POLICY_REASON,
}) satisfies OpenApiSchema;

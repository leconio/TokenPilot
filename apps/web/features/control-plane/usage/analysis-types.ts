export type AnalysisKind = "aiu" | "cost" | "usage";
export type AnalysisMetric =
  | "requests"
  | "tokens"
  | "unique_users"
  | "success_rate"
  | "average_latency"
  | "provider_cost"
  | "aiu";
export type AnalysisMatch = "all" | "any";
export type AnalysisRange = "24h" | "7d" | "30d" | "90d";
export type AnalysisGrain = "hour" | "day" | "week" | "month";
export type AnalysisDataType = "TEXT" | "NUMBER" | "BOOLEAN" | "DATETIME" | "ENUM" | "TEXT_LIST";
export type AnalysisOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "starts_with"
  | "greater_than"
  | "greater_or_equal"
  | "less_than"
  | "less_or_equal"
  | "between"
  | "one_of"
  | "contains_any"
  | "contains_all"
  | "is_set"
  | "is_not_set";
export type AnalysisValue = string | number | boolean;
export type AnalysisBuiltInField =
  | "event_id"
  | "request_id"
  | "model_id"
  | "user_id"
  | "display_user"
  | "user_tag"
  | "user_group"
  | "model_tag"
  | "virtual_model"
  | "provider"
  | "route_reason"
  | "status"
  | "cost_status"
  | "aiu_status"
  | "latency_ms";
export type AnalysisBuiltInGroup =
  "model_tag" | "virtual_model" | "provider" | "user_id" | "user_tag" | "route_reason" | "time";

export type AnalysisCondition =
  | Readonly<{
      id: string;
      kind: "builtin";
      field: AnalysisBuiltInField;
      operator: AnalysisOperator;
      values: readonly AnalysisValue[];
    }>
  | Readonly<{
      id: string;
      kind: "property";
      scope: "event" | "user";
      key: string;
      data_type: AnalysisDataType;
      operator: AnalysisOperator;
      values: readonly AnalysisValue[];
    }>;

export type AnalysisGroup =
  | Readonly<{ kind: "builtin"; dimension: AnalysisBuiltInGroup }>
  | Readonly<{ kind: "property"; scope: "event" | "user"; key: string; label: string }>;

export interface AnalysisSelection {
  readonly range: AnalysisRange;
  readonly metric: AnalysisMetric;
  readonly match: AnalysisMatch;
  readonly conditions: readonly AnalysisCondition[];
  readonly group: AnalysisGroup;
  readonly grain: AnalysisGrain;
}

export interface AnalysisFieldDefinition {
  readonly id: string;
  readonly kind: "builtin" | "property";
  readonly label: string;
  readonly placeholder: string;
  readonly data_type: AnalysisDataType;
  readonly operators: readonly AnalysisOperator[];
  readonly field?: AnalysisBuiltInField;
  readonly scope?: "event" | "user";
  readonly key?: string;
  readonly allowed_values?: readonly string[];
  readonly allow_custom_value?: boolean;
  readonly sensitive?: boolean;
  readonly searchable?: boolean;
}

export interface SavedReportDefinition {
  readonly version: 1;
  readonly range: AnalysisRange;
  readonly metric: AnalysisMetric;
  readonly filter_match: AnalysisMatch;
  readonly conditions: readonly (
    | Readonly<{
        kind: "builtin";
        field: AnalysisBuiltInField;
        operator: AnalysisOperator;
        values: readonly AnalysisValue[];
      }>
    | Readonly<{
        kind: "property";
        scope: "event" | "user";
        key: string;
        operator: AnalysisOperator;
        values: readonly AnalysisValue[];
      }>
  )[];
  readonly group:
    | Readonly<{ kind: "builtin"; dimension: AnalysisBuiltInGroup }>
    | Readonly<{ kind: "property"; scope: "event" | "user"; key: string }>;
  readonly grain: AnalysisGrain;
}

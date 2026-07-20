import type {
  AnalysisBuiltInField,
  AnalysisBuiltInGroup,
  AnalysisCondition,
  AnalysisDataType,
  AnalysisFieldDefinition,
  AnalysisGrain,
  AnalysisGroup,
  AnalysisKind,
  AnalysisMetric,
  AnalysisOperator,
  AnalysisRange,
  AnalysisSelection,
} from "./analysis-types";

export type * from "./analysis-types";
export { analysisFileName, rowsToCsv } from "./analysis-export";
export {
  analysisRange,
  conditionFieldId,
  reportParameters,
  selectionForGroupDrill,
  selectionFromDefinition,
  selectionToDefinition,
} from "./analysis-selection";

export const analysisRanges: ReadonlyArray<{ value: AnalysisRange; label: string }> = [
  { value: "24h", label: "最近 24 小时" },
  { value: "7d", label: "最近 7 天" },
  { value: "30d", label: "最近 30 天" },
  { value: "90d", label: "最近 90 天" },
];

const metricsByKind: Readonly<
  Record<AnalysisKind, readonly { value: AnalysisMetric; label: string }[]>
> = {
  usage: [
    { value: "requests", label: "调用次数" },
    { value: "tokens", label: "Token" },
    { value: "unique_users", label: "独立用户" },
    { value: "success_rate", label: "成功率" },
    { value: "average_latency", label: "平均耗时" },
  ],
  cost: [{ value: "provider_cost", label: "模型花费" }],
  aiu: [{ value: "aiu", label: "AIU 用量" }],
};

export function analysisMetrics(
  kind: AnalysisKind,
): readonly { value: AnalysisMetric; label: string }[] {
  return metricsByKind[kind];
}

const textOperators: readonly AnalysisOperator[] = [
  "equals",
  "not_equals",
  "contains",
  "starts_with",
  "is_set",
  "is_not_set",
];
const equalityOperators: readonly AnalysisOperator[] = [
  "equals",
  "not_equals",
  "is_set",
  "is_not_set",
];
const numericOperators: readonly AnalysisOperator[] = [
  "equals",
  "not_equals",
  "greater_than",
  "greater_or_equal",
  "less_than",
  "less_or_equal",
  "between",
  "is_set",
  "is_not_set",
];

const commonFields: readonly AnalysisFieldDefinition[] = [
  field("event_id", "事件 ID", "输入事件 ID", "TEXT", equalityOperators, true),
  field("request_id", "请求 ID", "输入请求 ID", "TEXT", equalityOperators, true),
  field("model_id", "模型 ID", "输入模型 ID", "TEXT", equalityOperators, true),
  field("request_model", "模型标识", "搜索模型标识", "TEXT", textOperators),
  field("virtual_model", "虚拟模型", "搜索虚拟模型", "TEXT", textOperators),
  field("connection_id", "调用连接", "选择调用连接", "TEXT", equalityOperators),
  field("connection_driver", "连接类型", "选择连接类型", "TEXT", equalityOperators),
  field("provider", "服务商", "搜索服务商", "TEXT", textOperators),
  field("route_reason", "调用原因", "输入调用原因", "TEXT", textOperators, true),
  field("user_id", "用户 ID", "搜索用户 ID", "TEXT", textOperators, true),
  field("display_user", "用户名", "搜索用户名", "TEXT", textOperators, true),
  field("user_tag", "用户标签", "选择用户标签", "ENUM", equalityOperators),
  field("user_group", "用户组", "选择用户组", "ENUM", ["equals", "not_equals", "one_of"]),
  field("status", "调用结果", "选择调用结果", "ENUM", equalityOperators),
  field("latency_ms", "耗时（毫秒）", "输入毫秒数", "NUMBER", numericOperators, true),
];

function field(
  value: AnalysisBuiltInField,
  label: string,
  placeholder: string,
  dataType: AnalysisDataType,
  operators: readonly AnalysisOperator[],
  allowCustomValue = false,
): AnalysisFieldDefinition {
  return {
    id: `builtin:${value}`,
    kind: "builtin",
    field: value,
    label,
    placeholder,
    data_type: dataType,
    operators,
    allow_custom_value: allowCustomValue,
  };
}

export function builtInAnalysisFields(kind: AnalysisKind): readonly AnalysisFieldDefinition[] {
  if (kind === "cost") {
    return [
      ...commonFields,
      field("cost_status", "成本状态", "选择成本状态", "ENUM", equalityOperators),
    ];
  }
  if (kind === "aiu") {
    return [
      ...commonFields,
      field("aiu_status", "AIU 状态", "选择 AIU 状态", "ENUM", equalityOperators),
    ];
  }
  return commonFields;
}

export const builtInAnalysisGroups: readonly AnalysisGroup[] = [
  { kind: "builtin", dimension: "model_id" },
  { kind: "builtin", dimension: "request_model" },
  { kind: "builtin", dimension: "virtual_model" },
  { kind: "builtin", dimension: "connection_id" },
  { kind: "builtin", dimension: "connection_driver" },
  { kind: "builtin", dimension: "provider" },
  { kind: "builtin", dimension: "user_id" },
  { kind: "builtin", dimension: "user_tag" },
  { kind: "builtin", dimension: "route_reason" },
  { kind: "builtin", dimension: "time" },
];

export const analysisGrains: ReadonlyArray<{ value: AnalysisGrain; label: string }> = [
  { value: "hour", label: "每小时" },
  { value: "day", label: "每天" },
  { value: "week", label: "每周" },
  { value: "month", label: "每月" },
];

const groupLabels: Readonly<Record<AnalysisBuiltInGroup, string>> = {
  model_id: "真实模型",
  request_model: "模型标识",
  virtual_model: "虚拟模型",
  connection_id: "调用连接",
  connection_driver: "连接类型",
  provider: "服务商",
  user_id: "用户",
  user_tag: "用户标签",
  route_reason: "调用原因",
  time: "时间",
};

export function analysisGroupLabel(group: AnalysisGroup): string {
  return group.kind === "property" ? group.label : groupLabels[group.dimension];
}

export function analysisGroupValue(group: AnalysisGroup): string {
  return group.kind === "property"
    ? `property:${group.scope}:${group.key}`
    : `builtin:${group.dimension}`;
}

export function defaultAnalysisSelection(kind: AnalysisKind): AnalysisSelection {
  return {
    range: "7d",
    metric: metricsByKind[kind][0]!.value,
    match: "all",
    conditions: [],
    group: { kind: "builtin", dimension: kind === "aiu" ? "user_id" : "request_model" },
    grain: kind === "aiu" ? "day" : "hour",
  };
}

export function analysisSelectionFromSearch(
  kind: AnalysisKind,
  search: Readonly<Pick<URLSearchParams, "get">>,
): AnalysisSelection {
  const selection = defaultAnalysisSelection(kind);
  const requestedRange = search.get("range");
  const range = analysisRanges.some((candidate) => candidate.value === requestedRange)
    ? (requestedRange as AnalysisRange)
    : selection.range;
  const match = search.get("filter_match") === "any" ? "any" : "all";
  const requestedMetric = search.get("metric");
  const metric =
    metricsByKind[kind].find((candidate) => candidate.value === requestedMetric)?.value ??
    selection.metric;
  const encoded = search.get("conditions");
  if (encoded === null) return { ...selection, range, metric, match };
  try {
    const conditions = JSON.parse(encoded) as unknown;
    if (!Array.isArray(conditions)) return { ...selection, range, metric, match };
    return {
      ...selection,
      range,
      metric,
      match,
      conditions: conditions.flatMap((value, index) => hydrateCondition(value, `query-${index}`)),
    };
  } catch {
    return { ...selection, range, metric, match };
  }
}

function hydrateCondition(value: unknown, id: string): readonly AnalysisCondition[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const item = value as Record<string, unknown>;
  if (!Array.isArray(item.values) || typeof item.operator !== "string") return [];
  if (item.kind === "builtin" && typeof item.field === "string") {
    return [{ ...item, id } as AnalysisCondition];
  }
  if (item.kind === "property" && typeof item.scope === "string" && typeof item.key === "string") {
    return [{ ...item, id, data_type: "TEXT" } as AnalysisCondition];
  }
  return [];
}

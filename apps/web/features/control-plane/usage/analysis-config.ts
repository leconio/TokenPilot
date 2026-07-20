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
  AnalysisValue,
  SavedReportDefinition,
} from "./analysis-types";

export type * from "./analysis-types";
export { analysisFileName, rowsToCsv } from "./analysis-export";

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
  field("model_tag", "模型", "搜索 LiteLLM 标签", "TEXT", textOperators),
  field("virtual_model", "虚拟模型", "搜索虚拟模型", "TEXT", textOperators),
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
  { kind: "builtin", dimension: "model_tag" },
  { kind: "builtin", dimension: "virtual_model" },
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
  model_tag: "模型",
  virtual_model: "虚拟模型",
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

export function conditionFieldId(condition: AnalysisCondition): string {
  return condition.kind === "property"
    ? `property:${condition.scope}:${condition.key}`
    : `builtin:${condition.field}`;
}

export function defaultAnalysisSelection(kind: AnalysisKind): AnalysisSelection {
  return {
    range: "7d",
    metric: metricsByKind[kind][0]!.value,
    match: "all",
    conditions: [],
    group: { kind: "builtin", dimension: kind === "aiu" ? "user_id" : "model_tag" },
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

export function analysisRange(range: AnalysisRange, now: Date = new Date()) {
  const to = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const days = range === "24h" ? 1 : range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return { from: new Date(to.getTime() - days * 86_400_000).toISOString(), to: to.toISOString() };
}

function reportCondition(
  condition: AnalysisCondition,
): SavedReportDefinition["conditions"][number] {
  if (condition.kind === "builtin") {
    return {
      kind: condition.kind,
      field: condition.field,
      operator: condition.operator,
      values: condition.values,
    };
  }
  return {
    kind: condition.kind,
    scope: condition.scope,
    key: condition.key,
    operator: condition.operator,
    values: condition.values,
  };
}

export function reportParameters(
  selection: AnalysisSelection,
  now: Date = new Date(),
  includeGroup = true,
  useTimeGrain = false,
  pageSize = 100,
): Readonly<Record<string, string | number | readonly string[] | undefined>> {
  const dimension =
    selection.group.kind === "property"
      ? "property"
      : useTimeGrain && selection.group.dimension === "time"
        ? selection.grain
        : selection.group.dimension;
  return {
    ...analysisRange(selection.range, now),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    page_size: pageSize,
    filter_match: selection.match,
    metric: selection.metric,
    grain: selection.grain,
    conditions: JSON.stringify(selection.conditions.map(reportCondition)),
    ...(includeGroup ? { group_dimension: dimension } : {}),
    ...(includeGroup && selection.group.kind === "property"
      ? {
          group_property: JSON.stringify({
            scope: selection.group.scope,
            key: selection.group.key,
          }),
        }
      : {}),
  };
}

export function selectionToDefinition(selection: AnalysisSelection): SavedReportDefinition {
  return {
    version: 1,
    range: selection.range,
    metric: selection.metric,
    filter_match: selection.match,
    conditions: selection.conditions.map(reportCondition),
    group:
      selection.group.kind === "property"
        ? { kind: "property", scope: selection.group.scope, key: selection.group.key }
        : selection.group,
    grain: selection.grain,
  };
}

export function selectionFromDefinition(
  definition: SavedReportDefinition,
  propertyFields: readonly AnalysisFieldDefinition[],
): AnalysisSelection {
  const conditions: readonly AnalysisCondition[] = definition.conditions.map((condition, index) => {
    if (condition.kind === "builtin") {
      return { ...condition, id: `saved-${index}` } satisfies AnalysisCondition;
    }
    const field = propertyFields.find(
      (candidate) => candidate.scope === condition.scope && candidate.key === condition.key,
    );
    return {
      ...condition,
      id: `saved-${index}`,
      data_type: field?.data_type ?? "TEXT",
    } satisfies AnalysisCondition;
  });
  const savedGroup = definition.group;
  const group: AnalysisGroup =
    savedGroup.kind === "builtin"
      ? savedGroup
      : {
          ...savedGroup,
          label:
            propertyFields.find(
              (field) => field.scope === savedGroup.scope && field.key === savedGroup.key,
            )?.label ?? savedGroup.key,
        };
  return {
    range: definition.range,
    metric: definition.metric,
    match: definition.filter_match,
    conditions,
    group,
    grain: definition.grain,
  };
}

export function selectionForGroupDrill(
  selection: AnalysisSelection,
  propertyFields: readonly AnalysisFieldDefinition[],
  key: string,
): AnalysisSelection | null {
  if (selection.group.kind === "builtin") {
    if (selection.group.dimension === "time") return null;
    const field = selection.group.dimension;
    const id = `builtin:${field}`;
    return {
      ...selection,
      conditions: [
        ...selection.conditions.filter((condition) => conditionFieldId(condition) !== id),
        { id: `drill-${field}`, kind: "builtin", field, operator: "equals", values: [key] },
      ],
    };
  }
  const group = selection.group;
  const field = propertyFields.find(
    (candidate) =>
      candidate.kind === "property" &&
      candidate.scope === group.scope &&
      candidate.key === group.key,
  );
  if (
    field === undefined ||
    field.searchable === false ||
    field.sensitive ||
    field.data_type === "TEXT_LIST"
  ) {
    return null;
  }
  let value: AnalysisValue = key;
  if (field.data_type === "NUMBER") {
    const numeric = Number(key);
    if (!Number.isFinite(numeric)) return null;
    value = numeric;
  } else if (field.data_type === "BOOLEAN") {
    if (!["0", "1", "false", "true"].includes(key)) return null;
    value = key === "1" || key === "true";
  } else if (field.data_type === "DATETIME") {
    const instant = new Date(key);
    if (!Number.isFinite(instant.getTime())) return null;
    value = instant.toISOString();
  }
  const id = `property:${group.scope}:${group.key}`;
  return {
    ...selection,
    conditions: [
      ...selection.conditions.filter((condition) => conditionFieldId(condition) !== id),
      {
        id: `drill-${group.key}`,
        kind: "property",
        scope: group.scope,
        key: group.key,
        data_type: field.data_type,
        operator: "equals",
        values: [value],
      },
    ],
  };
}

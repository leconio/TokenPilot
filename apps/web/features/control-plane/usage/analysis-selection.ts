import type {
  AnalysisCondition,
  AnalysisFieldDefinition,
  AnalysisGroup,
  AnalysisRange,
  AnalysisSelection,
  AnalysisValue,
  SavedReportDefinition,
} from "./analysis-types";

export function conditionFieldId(condition: AnalysisCondition): string {
  return condition.kind === "property"
    ? `property:${condition.scope}:${condition.key}`
    : `builtin:${condition.field}`;
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

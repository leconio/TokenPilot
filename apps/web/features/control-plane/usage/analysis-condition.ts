import type { AnalysisCondition, AnalysisFieldDefinition } from "./analysis-config";

export function newAnalysisCondition(field: AnalysisFieldDefinition): AnalysisCondition {
  const common = {
    id: `condition-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    operator: field.operators[0] ?? ("equals" as const),
    values: [],
  };
  return field.kind === "builtin"
    ? { ...common, kind: "builtin", field: field.field! }
    : {
        ...common,
        kind: "property",
        scope: field.scope!,
        key: field.key!,
        data_type: field.data_type,
      };
}

export function isAnalysisConditionComplete(condition: AnalysisCondition): boolean {
  if (condition.operator === "is_set" || condition.operator === "is_not_set") return true;
  return condition.operator === "between"
    ? condition.values.length === 2
    : condition.values.length > 0;
}

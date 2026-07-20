import type { PropertyDataType } from "@tokenpilot/db";

import type { ReportQuery, ResolvedReportFilterCondition } from "./query.js";
import type { ReportRow } from "./data.js";

export type ClickHouseQueryParams = Record<string, string | number | boolean | readonly string[]>;
export interface ClickHouseFilter {
  readonly sql: string;
  readonly params: ClickHouseQueryParams;
}
export type ClickHouseExecute = (
  statement: (where: string) => string,
) => Promise<readonly ReportRow[]>;

const builtinColumns = {
  event_id: "event_id",
  request_id: "request_id",
  attempt_id: "attempt_id",
  operation_id: "operation_id",
  session_id: "session_id",
  conversation_id: "conversation_id",
  user_id: "user_id",
  display_user: "display_user",
  application_version: "application_version",
  sdk_version: "sdk_version",
  connector_version: "connector_version",
  config_version: "config_version",
  virtual_model: "virtual_model",
  model_id: "model_id",
  connection_id: "connection_id",
  connection_driver: "connection_driver",
  request_model: "request_model",
  provider: "provider",
  status: "status",
  schema_version: "schema_version",
  route_reason: "route_reason",
} as const;

const textOperators = new Set([
  "equals",
  "not_equals",
  "contains",
  "starts_with",
  "one_of",
  "is_set",
  "is_not_set",
]);
const numericOperators = new Set([
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

function valueParameter(index: number, valueIndex: number): string {
  return `filter_${index}_value_${valueIndex}`;
}

function comparison(
  expression: string,
  operator: string,
  parameters: readonly string[],
  parameterType: string,
): string {
  const parameter = (index: number) => `{${parameters[index]}:${parameterType}}`;
  if (operator === "is_set") return `notEmpty(toString(${expression}))`;
  if (operator === "is_not_set") return `empty(toString(${expression}))`;
  if (operator === "between") {
    return `(${expression} >= ${parameter(0)} AND ${expression} <= ${parameter(1)})`;
  }
  const operation = {
    equals: "=",
    not_equals: "!=",
    greater_than: ">",
    greater_or_equal: ">=",
    less_than: "<",
    less_or_equal: "<=",
  }[operator];
  if (operation !== undefined) {
    const joiner = operator === "not_equals" ? " AND " : " OR ";
    return `(${parameters.map((_, index) => `${expression} ${operation} ${parameter(index)}`).join(joiner)})`;
  }
  if (operator === "contains") {
    return `(${parameters.map((_, index) => `positionCaseInsensitiveUTF8(${expression}, ${parameter(index)}) > 0`).join(" OR ")})`;
  }
  if (operator === "starts_with") {
    return `(${parameters.map((_, index) => `startsWith(lowerUTF8(${expression}), lowerUTF8(${parameter(index)}))`).join(" OR ")})`;
  }
  if (operator === "one_of") {
    return `(${parameters.map((_, index) => `${expression} = ${parameter(index)}`).join(" OR ")})`;
  }
  throw new TypeError(`Unsupported report operator ${operator}`);
}

function ratingStatusFilter(
  kind: "provider_cost" | "aiu",
  condition: ResolvedReportFilterCondition,
  parameters: readonly string[],
): string {
  if (!["equals", "not_equals", "one_of", "is_set", "is_not_set"].includes(condition.operator)) {
    throw new TypeError("Rating status only supports equality comparisons");
  }
  const missing = condition.operator === "is_not_set";
  const predicate = comparison(
    "rating_status",
    missing ? "is_set" : condition.operator,
    parameters,
    "String",
  );
  return `event.event_id ${missing ? "NOT IN" : "IN"} (
    SELECT source_event_id
    FROM (
      SELECT
        source_event_id,
        argMax(status, tuple(authority_outbox_id, rating_event_id)) AS rating_status
      FROM current_rating_events
      WHERE event_time >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
        AND event_time < parseDateTime64BestEffort({to:String}, 3, 'UTC')
        AND application_id = {application_id:String}
        AND rating_kind = '${kind}'
      GROUP BY source_event_id
    )
    WHERE ${predicate}
  )`;
}

export function propertyColumn(type: PropertyDataType, scope: "event" | "user"): string {
  const suffix = {
    TEXT: "text_properties",
    NUMBER: "number_properties",
    BOOLEAN: "boolean_properties",
    DATETIME: "datetime_properties",
    ENUM: "enum_properties",
    TEXT_LIST: "text_list_properties",
  }[type];
  return `${scope}_${suffix}`;
}

function propertyFilter(
  condition: Extract<ResolvedReportFilterCondition, { kind: "property" }>,
  index: number,
  parameters: readonly string[],
): string {
  if (condition.dataType === undefined) throw new TypeError("Property type was not resolved");
  const key = `filter_${index}_key`;
  const column = propertyColumn(condition.dataType, condition.scope);
  const map = `event.${column}`;
  const expression = `${map}[{${key}:String}]`;
  const exists = `mapContains(${map}, {${key}:String})`;
  if (condition.operator === "is_set") return exists;
  if (condition.operator === "is_not_set") return `NOT ${exists}`;
  if (condition.dataType === "TEXT_LIST") {
    const checks = parameters.map((parameter) => `has(${expression}, {${parameter}:String})`);
    const joiner = condition.operator === "contains_all" ? " AND " : " OR ";
    return `(${exists} AND (${checks.join(joiner)}))`;
  }
  const parameterType =
    condition.dataType === "NUMBER"
      ? "Float64"
      : condition.dataType === "BOOLEAN"
        ? "UInt8"
        : condition.dataType === "DATETIME"
          ? "DateTime64(3, 'UTC')"
          : "String";
  return `(${exists} AND ${comparison(expression, condition.operator, parameters, parameterType)})`;
}

function compileCondition(
  condition: ResolvedReportFilterCondition,
  index: number,
): ClickHouseFilter {
  if (condition.kind === "builtin" && condition.field === "user_group") {
    if (condition.userIds === undefined)
      throw new TypeError("User group members were not resolved");
    if (condition.userIds.length === 0) {
      return { sql: condition.operator === "not_equals" ? "1" : "0", params: {} };
    }
    const key = `filter_${index}_user_ids`;
    const operation = condition.operator === "not_equals" ? "NOT IN" : "IN";
    return {
      sql: `event.user_id ${operation} {${key}:Array(String)}`,
      params: { [key]: condition.userIds },
    };
  }
  const parameters = condition.values.map((_, valueIndex) => valueParameter(index, valueIndex));
  const params: ClickHouseQueryParams = Object.fromEntries(
    condition.values.map((value, valueIndex) => [
      parameters[valueIndex]!,
      condition.kind === "property" && condition.dataType === "BOOLEAN" ? Number(value) : value,
    ]),
  );
  if (condition.kind === "property") {
    params[`filter_${index}_key`] = condition.key;
    return { sql: propertyFilter(condition, index, parameters), params };
  }
  if (condition.field === "cost_status") {
    return { sql: ratingStatusFilter("provider_cost", condition, parameters), params };
  }
  if (condition.field === "aiu_status") {
    return { sql: ratingStatusFilter("aiu", condition, parameters), params };
  }
  if (condition.field === "quota_status") {
    const expression = "event.analytics_dimensions['quota_status']";
    return { sql: comparison(expression, condition.operator, parameters, "String"), params };
  }
  if (condition.field === "user_tag") {
    if (!["equals", "not_equals", "one_of", "is_set", "is_not_set"].includes(condition.operator)) {
      throw new TypeError("User tags only support selection comparisons");
    }
    if (condition.operator === "is_set") {
      return { sql: "notEmpty(event.user_tags)", params };
    }
    if (condition.operator === "is_not_set") {
      return { sql: "empty(event.user_tags)", params };
    }
    const checks = parameters.map((parameter) => `has(event.user_tags, {${parameter}:String})`);
    return {
      sql:
        condition.operator === "not_equals"
          ? `(${checks.map((check) => `NOT ${check}`).join(" AND ")})`
          : `(${checks.join(" OR ")})`,
      params,
    };
  }
  if (condition.field === "latency_ms") {
    if (!numericOperators.has(condition.operator))
      throw new TypeError("Invalid latency comparison");
    return {
      sql: comparison("event.latency_ms", condition.operator, parameters, "Float64"),
      params,
    };
  }
  if (condition.field === "user_group") {
    throw new TypeError("User group members were not resolved");
  }
  if (!textOperators.has(condition.operator)) throw new TypeError("Invalid text comparison");
  const column = builtinColumns[condition.field];
  return { sql: comparison(`event.${column}`, condition.operator, parameters, "String"), params };
}

function conditionKey(condition: ResolvedReportFilterCondition): string {
  return condition.kind === "builtin"
    ? condition.field
    : `${condition.scope}_property:${condition.key}`;
}

export function clickHouseFilters(query: ReportQuery): ClickHouseFilter {
  const conditions = [
    "event.application_id = {application_id:String}",
    "event.event_time >= parseDateTime64BestEffort({from:String}, 3, 'UTC')",
    "event.event_time < parseDateTime64BestEffort({to:String}, 3, 'UTC')",
  ];
  const params: ClickHouseQueryParams = {
    application_id: query.applicationId,
    from: query.from.toISOString(),
    to: query.to.toISOString(),
    timezone: query.timezone,
  };
  if (query.groupProperty !== undefined) params.group_property_key = query.groupProperty.key;
  if (query.usageCursor !== null) {
    params.cursor_event_time = query.usageCursor.eventTime;
    params.cursor_event_id = query.usageCursor.eventId;
  }
  if (query.groupCursor !== null) {
    params.cursor_group_key = query.groupCursor.groupKey;
    params.cursor_secondary_key = query.groupCursor.secondaryKey;
  }
  const compiled = query.filters.map(compileCondition);
  if (compiled.length > 0) {
    const grouped = new Map<string, string[]>();
    for (const [index, filter] of compiled.entries()) {
      const key = conditionKey(query.filters[index]!);
      grouped.set(key, [...(grouped.get(key) ?? []), filter.sql]);
      Object.assign(params, filter.params);
    }
    const groups = [...grouped.values()].map((values) => `(${values.join(" OR ")})`);
    conditions.push(`(${groups.join(query.filterMatch === "any" ? " OR " : " AND ")})`);
  }
  return { sql: conditions.join(" AND "), params };
}

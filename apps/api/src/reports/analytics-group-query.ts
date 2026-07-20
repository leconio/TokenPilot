import type { ReportGroupDimension } from "@tokenpilot/contracts";

import { analyticsOverviewQueryPlan } from "./analytics-overview-query.js";
import { propertyColumn } from "./clickhouse-query.js";
import type { ReportQuery } from "./query.js";

const minuteGroupDimensions = new Set<ReportGroupDimension>([
  "model_tag",
  "virtual_model",
  "provider",
  "route_reason",
  "time",
  "hour",
  "day",
  "week",
  "month",
]);

export function groupExpression(dimension: ReportGroupDimension): string {
  if (dimension === "model_tag") return "event.model_tag";
  if (dimension === "virtual_model") return "event.virtual_model";
  if (dimension === "provider") return "event.provider";
  if (dimension === "user_id") return "event.user_id";
  if (dimension === "user_tag") {
    return "arrayJoin(if(empty(event.user_tags), [''], event.user_tags))";
  }
  if (dimension === "route_reason") return "event.route_reason";
  if (dimension === "property") throw new TypeError("Custom field grouping requires a query");
  const interval =
    dimension === "time" || dimension === "hour"
      ? "HOUR"
      : dimension === "day"
        ? "DAY"
        : dimension === "week"
          ? "WEEK"
          : "MONTH";
  return `formatDateTime(
    toStartOfInterval(event.event_time, INTERVAL 1 ${interval}, {timezone:String}),
    '%Y-%m-%dT%H:%i:%S.000Z',
    'UTC'
  )`;
}

export function groupQueryPlan(query: ReportQuery) {
  const overview = analyticsOverviewQueryPlan(query);
  const group =
    query.groupDimension === "property"
      ? propertyGroupExpression(query)
      : groupExpression(query.groupDimension);
  return {
    ...overview,
    group,
    useMinuteAggregate:
      overview.useMinuteAggregate && minuteGroupDimensions.has(query.groupDimension),
  } as const;
}

function propertyGroupExpression(query: ReportQuery): string {
  const property = query.groupProperty;
  if (property?.dataType === undefined) throw new TypeError("Custom group field was not resolved");
  const expression = `event.${propertyColumn(property.dataType, property.scope)}[{group_property_key:String}]`;
  return property.dataType === "TEXT_LIST"
    ? `arrayStringConcat(${expression}, ', ')`
    : `toString(${expression})`;
}

export function providerGroupCursorPredicate(query: ReportQuery, alias = "grouped"): string {
  if (query.groupCursor === null) return "1 = 1";
  return `(
    ${alias}.group_key > {cursor_group_key:String}
    OR (
      ${alias}.group_key = {cursor_group_key:String}
      AND ${alias}.currency > {cursor_secondary_key:String}
    )
  )`;
}

export function aiuGroupCursorPredicate(query: ReportQuery, alias = "grouped"): string {
  return query.groupCursor === null ? "1 = 1" : `${alias}.group_key > {cursor_group_key:String}`;
}

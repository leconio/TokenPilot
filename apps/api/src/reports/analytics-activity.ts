import type { ActivityMetricUnit, ActivityReportData, ReportMetric } from "@tokenpilot/contracts";

import { groupExpression, groupQueryPlan } from "./analytics-group-query.js";
import type { ClickHouseExecute } from "./clickhouse-query.js";
import { reportCount, reportString } from "./data.js";
import { encodeGroupCursor, groupCursorDimension, type ReportQuery } from "./query.js";

type ActivityMetric = Exclude<ReportMetric, "provider_cost" | "aiu">;

const units: Readonly<Record<ActivityMetric, ActivityMetricUnit>> = {
  requests: "calls",
  tokens: "tokens",
  unique_users: "users",
  success_rate: "percent",
  average_latency: "milliseconds",
};

function eventProjection(group: string, where: string): string {
  return `
    SELECT
      event.event_id,
      event.request_id,
      if(empty(event.operation_id), event.request_id, event.operation_id) AS operation_key,
      event.user_id,
      event.status,
      event.latency_ms,
      event.event_time,
      ifNull(toString(${group}), '') AS group_key
    FROM current_usage_events_raw AS event
    WHERE ${where}
  `;
}

const usageProjection = `
  SELECT
    line.event_id,
    sumIf(
      line.quantity,
      line.usage_type IN (
        'uncached_input_token',
        'cache_read_input_token',
        'cache_write_input_token',
        'output_token',
        'reasoning_output_token',
        'embedding_token'
      )
    ) AS total_tokens
  FROM current_usage_lines AS line
  WHERE line.application_id = {application_id:String}
    AND line.event_time >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
    AND line.event_time < parseDateTime64BestEffort({to:String}, 3, 'UTC')
    AND line.event_id IN (SELECT event_id FROM filtered_events)
  GROUP BY line.event_id
`;

function metricExpression(metric: ActivityMetric): string {
  if (metric === "requests") return "toString(uniqExact(event.operation_key))";
  if (metric === "tokens") return "toString(sum(ifNull(usage.total_tokens, 0)))";
  if (metric === "unique_users") {
    return "toString(uniqExactIf(event.user_id, notEmpty(event.user_id)))";
  }
  if (metric === "success_rate") {
    return `if(
      uniqExact(event.operation_key) = 0,
      NULL,
      toString(round(
        100 * uniqExactIf(event.operation_key, event.status = 'success') /
          uniqExact(event.operation_key),
        6
      ))
    )`;
  }
  return `if(
    countIf(isNotNull(event.latency_ms)) = 0,
    NULL,
    toString(round(avgIf(toFloat64(event.latency_ms), isNotNull(event.latency_ms)), 6))
  )`;
}

function metricQuery(
  metric: ActivityMetric,
  projection: string,
  selection: string,
  suffix = "",
): string {
  const usage = metric === "tokens" ? `, event_usage AS (${usageProjection})` : "";
  const join =
    metric === "tokens" ? "LEFT JOIN event_usage AS usage ON usage.event_id = event.event_id" : "";
  return `
    WITH filtered_events AS (${projection})${usage}
    SELECT ${selection}
    FROM filtered_events AS event
    ${join}
    ${suffix}
  `;
}

function groupCursorPredicate(query: ReportQuery): string {
  return query.groupCursor === null ? "1 = 1" : "group_key > {cursor_group_key:String}";
}

export async function queryAnalyticsActivity(
  execute: ClickHouseExecute,
  query: ReportQuery,
): Promise<ActivityReportData> {
  const metric = query.metric as ActivityMetric;
  const group = groupQueryPlan(query).group;
  const trendGroup = groupExpression(query.grain);
  const value = metricExpression(metric);
  const [totals, groups, groupCounts, trend] = await Promise.all([
    execute((where) =>
      metricQuery(metric, eventProjection(group, where), `${value} AS metric_value`),
    ),
    execute((where) =>
      metricQuery(
        metric,
        eventProjection(group, where),
        `event.group_key AS group_key, ${value} AS metric_value`,
        `WHERE ${groupCursorPredicate(query)}
         GROUP BY event.group_key
         ORDER BY event.group_key
         LIMIT ${query.pageSize}`,
      ),
    ),
    execute(
      (where) => `
        SELECT count() AS total_groups
        FROM (
          SELECT ifNull(toString(${group}), '') AS group_key
          FROM current_usage_events_raw AS event
          WHERE ${where}
          GROUP BY group_key
        )
      `,
    ),
    execute((where) =>
      metricQuery(
        metric,
        eventProjection(trendGroup, where),
        `event.group_key AS bucket, ${value} AS metric_value`,
        `GROUP BY event.group_key
         ORDER BY event.group_key
         LIMIT 10000`,
      ),
    ),
  ]);
  const totalGroups = reportCount(groupCounts[0]?.total_groups ?? 0);
  const position = (query.groupCursor?.position ?? 0) + groups.length;
  const last = groups.at(-1);
  const lastKey = reportString(last?.group_key);
  return {
    metric,
    unit: units[metric],
    total: reportString(totals[0]?.metric_value),
    group_dimension: query.groupDimension,
    groups: groups.map((row) => ({
      key: reportString(row.group_key) ?? "",
      value: reportString(row.metric_value),
    })),
    trend: trend.map((row) => ({
      key: reportString(row.bucket) ?? "",
      value: reportString(row.metric_value),
    })),
    page_size: query.pageSize,
    total_groups: totalGroups,
    next_cursor:
      lastKey !== null && position < totalGroups
        ? encodeGroupCursor({
            kind: "activity",
            dimension: groupCursorDimension(query),
            groupKey: lastKey,
            secondaryKey: "",
            position,
          })
        : null,
  };
}

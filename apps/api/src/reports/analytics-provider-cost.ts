import type { ProviderCostGroup, ProviderCostReportData, ReportMoney } from "@tokenpilot/contracts";

import type { ClickHouseExecute } from "./clickhouse-query.js";
import { reportCount, reportMoney, reportString, type ReportRow } from "./data.js";
import { groupQueryPlan, providerGroupCursorPredicate } from "./analytics-group-query.js";
import { encodeGroupCursor, groupCursorDimension, type ReportQuery } from "./query.js";

function moneyTotals(rows: readonly ReportRow[]): readonly ReportMoney[] {
  return rows.flatMap((row) => {
    const metric = reportMoney(row.amount, row.currency);
    return metric === null ? [] : [metric];
  });
}

function singleMoney(rows: readonly ReportRow[]): ReportMoney | null {
  return rows.length === 1 ? reportMoney(rows[0]?.amount, rows[0]?.currency) : null;
}

function costGroup(row: ReportRow, query: ReportQuery): ProviderCostGroup {
  const key = reportString(row.group_key) ?? "";
  const currency = reportString(row.currency);
  const amount = reportString(row.amount);
  if (currency === null || amount === null) throw new TypeError("Invalid Provider Cost group");
  return { dimension: query.groupDimension, key, currency, amount };
}

function scopedEvents(where: string, group: string, extra = ""): string {
  return `
    SELECT
      event.event_id,
      event.event_time,
      event.status,
      event.fallback_from,
      ${group} AS group_key
    FROM current_usage_events_raw AS event
    WHERE ${where} ${extra}
  `;
}

export async function queryAnalyticsProviderCost(
  execute: ClickHouseExecute,
  query: ReportQuery,
): Promise<ProviderCostReportData> {
  const plan = groupQueryPlan(query);
  const groupedSource = plan.useMinuteAggregate
    ? `
      SELECT
        ${plan.group} AS group_key,
        event.currency AS currency,
        toString(sum(
          event.provisional_provider_cost + event.official_provider_cost_delta
        )) AS amount
      FROM (${plan.aggregateEventProjection}) AS event
      WHERE __WHERE__ AND notEmpty(event.currency)
      GROUP BY group_key, event.currency
    `
    : `
      WITH filtered_events AS (${scopedEvents("__WHERE__", plan.group)})
      SELECT
        event.group_key AS group_key,
        assumeNotNull(rating.currency) AS currency,
        toString(sum(rating.rating_sign * assumeNotNull(rating.amount_decimal))) AS amount
      FROM filtered_events AS event
      INNER JOIN current_rating_events AS rating
        ON rating.event_time = event.event_time AND rating.source_event_id = event.event_id
      WHERE rating.rating_kind = 'provider_cost'
        AND isNotNull(rating.currency)
        AND isNotNull(rating.amount_decimal)
      GROUP BY event.group_key, rating.currency
    `;
  const [totalRows, fallbackRows, groupRows, groupCounts, unpricedRows] = await Promise.all([
    execute((where) =>
      plan.useMinuteAggregate
        ? `
          SELECT
            event.currency AS currency,
            toString(sum(
              event.provisional_provider_cost + event.official_provider_cost_delta
            )) AS amount,
            toString(sumIf(
              event.provisional_provider_cost + event.official_provider_cost_delta,
              event.status != 'success'
            )) AS failed_attempt_cost
          FROM (${plan.aggregateEventProjection}) AS event
          WHERE ${where} AND notEmpty(event.currency)
          GROUP BY event.currency ORDER BY event.currency
        `
        : `
          WITH filtered_events AS (${scopedEvents(where, plan.group)})
          SELECT
            assumeNotNull(rating.currency) AS currency,
            toString(sum(rating.rating_sign * assumeNotNull(rating.amount_decimal))) AS amount,
            toString(sumIf(
              rating.rating_sign * assumeNotNull(rating.amount_decimal),
              event.status != 'success'
            )) AS failed_attempt_cost
          FROM filtered_events AS event
          INNER JOIN current_rating_events AS rating
            ON rating.event_time = event.event_time AND rating.source_event_id = event.event_id
          WHERE rating.rating_kind = 'provider_cost'
            AND isNotNull(rating.currency)
            AND isNotNull(rating.amount_decimal)
          GROUP BY rating.currency ORDER BY rating.currency
        `,
    ),
    execute(
      (where) => `
        WITH filtered_events AS (${scopedEvents(where, plan.group, "AND notEmpty(event.fallback_from)")})
        SELECT
          assumeNotNull(rating.currency) AS currency,
          toString(sum(rating.rating_sign * assumeNotNull(rating.amount_decimal))) AS amount
        FROM filtered_events AS event
        INNER JOIN current_rating_events AS rating
          ON rating.event_time = event.event_time AND rating.source_event_id = event.event_id
        WHERE rating.rating_kind = 'provider_cost'
          AND isNotNull(rating.currency)
          AND isNotNull(rating.amount_decimal)
        GROUP BY rating.currency ORDER BY rating.currency
      `,
    ),
    execute((where) => {
      const grouped = groupedSource.replace("__WHERE__", where);
      return `
        WITH grouped AS (${grouped})
        SELECT group_key, currency, amount
        FROM grouped
        WHERE ${providerGroupCursorPredicate(query)}
        ORDER BY group_key, currency
        LIMIT ${query.pageSize}
      `;
    }),
    execute((where) => {
      const grouped = groupedSource.replace("__WHERE__", where);
      return `SELECT count() AS total FROM (${grouped})`;
    }),
    execute((where) =>
      plan.canFilterRatingsDirectly
        ? `
            SELECT greatest(
              toInt64((
                SELECT count()
                FROM current_usage_events_raw AS event
                WHERE ${where}
              )) - toInt64(countIf(provider_cost_status IN ('provisional', 'official'))),
              toInt64(0)
            ) AS count
            FROM (
              SELECT
                event.source_event_id,
                argMaxIf(
                  event.status,
                  tuple(event.authority_outbox_id, event.rating_event_id),
                  event.rating_kind = 'provider_cost'
                ) AS provider_cost_status
              FROM current_rating_events AS event
              WHERE ${where}
              GROUP BY event.source_event_id
            )
          `
        : `
            WITH filtered_events AS (${scopedEvents(where, plan.group)})
            SELECT greatest(
              toInt64((SELECT count() FROM filtered_events))
                - toInt64(countIf(provider_cost_status IN ('provisional', 'official'))),
              toInt64(0)
            ) AS count
            FROM (
              SELECT
                rating.source_event_id,
                argMaxIf(
                  rating.status,
                  tuple(rating.authority_outbox_id, rating.rating_event_id),
                  rating.rating_kind = 'provider_cost'
                ) AS provider_cost_status
              FROM current_rating_events AS rating
              WHERE ${plan.ratingRange("rating")}
                AND rating.source_event_id IN (SELECT event_id FROM filtered_events)
              GROUP BY rating.source_event_id
            )
          `,
    ),
  ]);
  const totals = moneyTotals(totalRows);
  const groups = groupRows.map((row) => costGroup(row, query));
  const totalGroups = reportCount(groupCounts[0]?.total ?? 0);
  const position = (query.groupCursor?.position ?? 0) + groups.length;
  const last = groups.at(-1);
  return {
    total: totals.length === 1 ? totals[0]! : null,
    totals,
    source_cost: null,
    cache_savings: null,
    failed_attempt_cost:
      totalRows.length === 1
        ? reportMoney(totalRows[0]?.failed_attempt_cost, totalRows[0]?.currency)
        : null,
    fallback_extra_cost: singleMoney(fallbackRows),
    unpriced_events: reportCount(unpricedRows[0]?.count ?? 0),
    group_dimension: query.groupDimension,
    groups,
    page_size: query.pageSize,
    total_groups: totalGroups,
    next_cursor:
      last !== undefined && position < totalGroups
        ? encodeGroupCursor({
            kind: "provider_cost",
            dimension: groupCursorDimension(query),
            groupKey: last.key,
            secondaryKey: last.currency,
            position,
          })
        : null,
  };
}

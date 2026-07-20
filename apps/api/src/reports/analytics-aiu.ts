import type { AiuGroup, AiuReportData } from "@tokenpilot/contracts";

import { groupQueryPlan, aiuGroupCursorPredicate } from "./analytics-group-query.js";
import type { ClickHouseExecute } from "./clickhouse-query.js";
import { reportAiu, reportCount, reportString, type ReportRow } from "./data.js";
import { encodeGroupCursor, groupCursorDimension, type ReportQuery } from "./query.js";

function aiuGroup(row: ReportRow, query: ReportQuery): AiuGroup {
  const aiuMicros = reportString(row.aiu_micros);
  if (aiuMicros === null) throw new TypeError("Invalid AIU group");
  return {
    dimension: query.groupDimension,
    key: reportString(row.group_key) ?? "",
    aiu_micros: aiuMicros,
  };
}

function scopedEvents(where: string, group: string): string {
  return `
    SELECT
      event.event_id,
      event.event_time,
      event.model_id,
      ${group} AS group_key
    FROM current_usage_events_raw AS event
    WHERE ${where}
  `;
}

export async function queryAnalyticsAiu(
  execute: ClickHouseExecute,
  query: ReportQuery,
): Promise<AiuReportData> {
  const plan = groupQueryPlan(query);
  const groupedSource = plan.useMinuteAggregate
    ? `
      SELECT
        ${plan.group} AS group_key,
        toString(sum(
          event.provisional_aiu_micros + event.official_aiu_micros_delta
        )) AS aiu_micros
      FROM (${plan.aggregateEventProjection}) AS event
      WHERE __WHERE__
      GROUP BY group_key
    `
    : `
      WITH
        filtered_events AS (${scopedEvents("__WHERE__", plan.group)}),
        rating_by_event AS (
          SELECT
            rating.source_event_id,
            sum(rating.rating_sign * assumeNotNull(rating.aiu_micros)) AS aiu_micros
          FROM current_rating_events AS rating
          WHERE ${plan.ratingRange("rating")}
            AND rating.rating_kind = 'aiu'
            AND isNotNull(rating.aiu_micros)
            AND rating.source_event_id IN (SELECT event_id FROM filtered_events)
          GROUP BY rating.source_event_id
        )
      SELECT
        event.group_key AS group_key,
        toString(sum(ifNull(rating.aiu_micros, 0))) AS aiu_micros
      FROM filtered_events AS event
      LEFT JOIN rating_by_event AS rating ON rating.source_event_id = event.event_id
      GROUP BY event.group_key
    `;
  const [summaryRows, ratingRows, totalRows, groupRows, groupCounts] = await Promise.all([
    execute(
      (where) => `
        SELECT
          count() AS event_count,
          countIf(empty(event.model_id)) AS unmapped_events
        FROM current_usage_events_raw AS event
        WHERE ${where}
      `,
    ),
    execute((where) =>
      plan.canFilterRatingsDirectly
        ? `
            SELECT countIf(
              aiu_status IN ('provisional', 'official', 'not_chargeable', 'disabled')
            ) AS rated_events
            FROM (
              SELECT
                event.source_event_id,
                argMaxIf(
                  event.status,
                  tuple(event.authority_outbox_id, event.rating_event_id),
                  event.rating_kind = 'aiu'
                ) AS aiu_status
              FROM current_rating_events AS event
              WHERE ${where}
              GROUP BY event.source_event_id
            )
          `
        : `
            WITH filtered_events AS (${scopedEvents(where, plan.group)})
            SELECT countIf(
              aiu_status IN ('provisional', 'official', 'not_chargeable', 'disabled')
            ) AS rated_events
            FROM (
              SELECT
                rating.source_event_id,
                argMaxIf(
                  rating.status,
                  tuple(rating.authority_outbox_id, rating.rating_event_id),
                  rating.rating_kind = 'aiu'
                ) AS aiu_status
              FROM current_rating_events AS rating
              WHERE ${plan.ratingRange("rating")}
                AND rating.source_event_id IN (SELECT event_id FROM filtered_events)
              GROUP BY rating.source_event_id
            )
          `,
    ),
    execute((where) =>
      plan.useMinuteAggregate
        ? `
          SELECT toString(sum(
            event.provisional_aiu_micros + event.official_aiu_micros_delta
          )) AS aiu_micros
          FROM (${plan.aggregateEventProjection}) AS event
          WHERE ${where}
        `
        : `
          WITH filtered_events AS (${scopedEvents(where, plan.group)})
          SELECT toString(sum(
            rating.rating_sign * assumeNotNull(rating.aiu_micros)
          )) AS aiu_micros
          FROM current_rating_events AS rating
          WHERE ${plan.ratingRange("rating")}
            AND rating.rating_kind = 'aiu'
            AND isNotNull(rating.aiu_micros)
            AND rating.source_event_id IN (SELECT event_id FROM filtered_events)
        `,
    ),
    execute((where) => {
      const grouped = groupedSource.replace("__WHERE__", where);
      return `
        WITH grouped AS (${grouped})
        SELECT group_key, aiu_micros
        FROM grouped
        WHERE ${aiuGroupCursorPredicate(query)}
        ORDER BY group_key
        LIMIT ${query.pageSize}
      `;
    }),
    execute((where) => {
      const grouped = groupedSource.replace("__WHERE__", where);
      return `SELECT count() AS total FROM (${grouped})`;
    }),
  ]);
  const summary = summaryRows[0] ?? {};
  const eventCount = reportCount(summary.event_count ?? 0);
  const ratedEvents = reportCount(ratingRows[0]?.rated_events ?? 0);
  const groups = groupRows.map((row) => aiuGroup(row, query));
  const totalGroups = reportCount(groupCounts[0]?.total ?? 0);
  const position = (query.groupCursor?.position ?? 0) + groups.length;
  const last = groups.at(-1);
  return {
    total: ratedEvents === 0 ? null : reportAiu(totalRows[0]?.aiu_micros),
    unrated_events: Math.max(eventCount - ratedEvents, 0),
    unmapped_events: reportCount(summary.unmapped_events ?? 0),
    group_dimension: query.groupDimension,
    groups,
    page_size: query.pageSize,
    total_groups: totalGroups,
    next_cursor:
      last !== undefined && position < totalGroups
        ? encodeGroupCursor({
            kind: "aiu",
            dimension: groupCursorDimension(query),
            groupKey: last.key,
            secondaryKey: "",
            position,
          })
        : null,
  };
}

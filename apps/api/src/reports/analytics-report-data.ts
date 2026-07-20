import type {
  OverviewReportData,
  PipelineHealthReportData,
  ReportMoney,
} from "@tokenpilot/contracts";

import {
  reportAiu,
  reportCount,
  reportInstant,
  reportMoney,
  reportString,
  type ReportRow,
} from "./data.js";
import type { ClickHouseExecute } from "./clickhouse-query.js";
import type { ReportQuery } from "./query.js";
import { analyticsOverviewQueryPlan } from "./analytics-overview-query.js";
function moneyTotals(rows: readonly ReportRow[]): readonly ReportMoney[] {
  return rows.flatMap((row) => {
    const metric = reportMoney(row.amount, row.currency);
    return metric === null ? [] : [metric];
  });
}

export async function queryAnalyticsOverview(
  execute: ClickHouseExecute,
  query: ReportQuery,
): Promise<OverviewReportData> {
  const plan = analyticsOverviewQueryPlan(query);
  const rangeMilliseconds = query.to.getTime() - query.from.getTime();
  const trendBucket =
    rangeMilliseconds <= 2 * 86_400_000
      ? "toStartOfHour(event.event_time)"
      : rangeMilliseconds <= 60 * 86_400_000
        ? "toStartOfDay(event.event_time)"
        : "toStartOfWeek(event.event_time, 1)";
  const [summaries, ratingEvidenceRows, costRows, aiuRows, tokenRows, trendRows] =
    await Promise.all([
      execute(
        (where) => `
        SELECT
          uniqExact(event.request_id) AS requests,
          uniqExact(tuple(event.request_id, event.attempt_id)) AS attempts,
          countIf(event.status = 'success') AS success,
          countIf(event.status != 'success') AS errors,
          count() AS event_count,
          countIf(empty(event.model_id)) AS unmapped_events,
          if(count() = 0, NULL, toString(max(event.event_time))) AS last_usage_received_at
        FROM current_usage_events_raw AS event
        WHERE ${where}
      `,
      ),
      execute((where) =>
        plan.canFilterRatingsDirectly
          ? plan.directRatingEvidence(where)
          : plan.scopedRatingEvidence(where),
      ),
      execute((where) =>
        plan.useMinuteAggregate
          ? `
          SELECT
            event.currency AS currency,
            toString(sum(
              event.provisional_provider_cost + event.official_provider_cost_delta
            )) AS amount
          FROM (${plan.aggregateEventProjection}) AS event
          WHERE ${where} AND notEmpty(event.currency)
          GROUP BY event.currency
          ORDER BY event.currency
        `
          : plan.canFilterRatingsDirectly
            ? `
            SELECT
              assumeNotNull(event.currency) AS currency,
              toString(sum(event.rating_sign * assumeNotNull(event.amount_decimal))) AS amount
            FROM current_rating_events AS event
            WHERE ${where}
              AND event.rating_kind = 'provider_cost'
              AND isNotNull(event.currency)
              AND isNotNull(event.amount_decimal)
            GROUP BY event.currency
            ORDER BY event.currency
          `
            : `
            WITH filtered_events AS (${plan.filteredEventIds(where)})
            SELECT
              assumeNotNull(rating.currency) AS currency,
              toString(sum(rating.rating_sign * assumeNotNull(rating.amount_decimal))) AS amount
            FROM current_rating_events AS rating
            WHERE ${plan.ratingRange("rating")}
              AND rating.source_event_id IN (SELECT event_id FROM filtered_events)
              AND rating.rating_kind = 'provider_cost'
              AND isNotNull(rating.currency)
              AND isNotNull(rating.amount_decimal)
            GROUP BY rating.currency
            ORDER BY rating.currency
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
          : plan.canFilterRatingsDirectly
            ? `
            SELECT toString(sum(
              event.rating_sign * assumeNotNull(event.aiu_micros)
            )) AS aiu_micros
            FROM current_rating_events AS event
            WHERE ${where}
              AND event.rating_kind = 'aiu'
              AND isNotNull(event.aiu_micros)
          `
            : `
            WITH filtered_events AS (${plan.filteredEventIds(where)})
            SELECT toString(sum(
              rating.rating_sign * assumeNotNull(rating.aiu_micros)
            )) AS aiu_micros
            FROM current_rating_events AS rating
            WHERE ${plan.ratingRange("rating")}
              AND rating.source_event_id IN (SELECT event_id FROM filtered_events)
              AND rating.rating_kind = 'aiu'
              AND isNotNull(rating.aiu_micros)
          `,
      ),
      execute(
        (where) => `
        WITH filtered_events AS (${plan.filteredEventIds(where)})
        SELECT toString(sumIf(
          line.quantity,
          line.usage_type IN (
            'uncached_input_token',
            'cache_read_input_token',
            'cache_write_input_token',
            'output_token',
            'reasoning_output_token',
            'embedding_token'
          )
        )) AS total_tokens
        FROM current_usage_lines AS line
        WHERE line.application_id = {application_id:String}
          AND line.event_time >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
          AND line.event_time < parseDateTime64BestEffort({to:String}, 3, 'UTC')
          AND line.event_id IN (SELECT event_id FROM filtered_events)
      `,
      ),
      execute(
        (where) => `
        SELECT
          formatDateTime(${trendBucket}, '%Y-%m-%dT%H:%i:%SZ', 'UTC') AS bucket,
          uniqExact(event.request_id) AS requests
        FROM current_usage_events_raw AS event
        WHERE ${where}
        GROUP BY bucket
        ORDER BY bucket
        LIMIT 500
      `,
      ),
    ]);
  const summary = summaries[0] ?? {};
  const ratingEvidence = ratingEvidenceRows[0] ?? {};
  const eventCount = reportCount(summary.event_count ?? 0);
  const pricedEvents = reportCount(ratingEvidence.priced_events ?? 0);
  const ratedAiuCount = reportCount(ratingEvidence.aiu_rated_count ?? 0);
  const costs = moneyTotals(costRows);
  const aiu = aiuRows[0] ?? {};
  return {
    provider_cost: costs.length === 1 ? costs[0]! : null,
    provider_costs: costs,
    requests: reportCount(summary.requests ?? 0),
    total_tokens: reportString(tokenRows[0]?.total_tokens) ?? "0",
    attempts: reportCount(summary.attempts ?? 0),
    success: reportCount(summary.success ?? 0),
    errors: reportCount(summary.errors ?? 0),
    unpriced_events: Math.max(eventCount - pricedEvents, 0),
    unmapped_events: reportCount(summary.unmapped_events ?? 0),
    aiu: ratedAiuCount === 0 ? null : reportAiu(aiu.aiu_micros),
    settlement_lag_seconds: null,
    reconciliation_status: null,
    last_usage_received_at: reportInstant(summary.last_usage_received_at),
    request_trend: trendRows.map((row) => ({
      bucket: reportString(row.bucket) ?? "",
      requests: reportCount(row.requests ?? 0),
    })),
  };
}

export async function queryAnalyticsPipelineHealth(
  execute: ClickHouseExecute,
  dependencies: Readonly<{
    postgres: "healthy";
    redis: "healthy";
    clickhouse: "healthy";
  }>,
): Promise<PipelineHealthReportData> {
  const rows = await execute(
    (where) => `
      SELECT
        count() AS event_count,
        if(count() = 0, NULL, toString(max(event.event_time))) AS last_event_at,
        if(count() = 0, NULL, toString(max(event.inserted_at))) AS last_inserted_at
      FROM current_usage_events_raw AS event
      WHERE ${where}
    `,
  );
  const row = rows[0] ?? {};
  return {
    connector: "unknown",
    postgres: dependencies.postgres,
    redis: dependencies.redis,
    clickhouse: dependencies.clickhouse,
    settlement: "unknown",
    reconciliation: "unknown",
    event_count: reportCount(row.event_count ?? 0),
    last_event_at: reportInstant(row.last_event_at),
    last_inserted_at: reportInstant(row.last_inserted_at),
    stages: [],
    inbox: [],
    outbox: [],
    sync: [],
  };
}

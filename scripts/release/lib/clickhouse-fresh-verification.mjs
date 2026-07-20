import { identifier, queryJsonRows } from "./clickhouse-fresh-rebuild.mjs";

const aggregateMetrics = Object.freeze([
  "request_count",
  "attempt_count",
  "success_count",
  "error_count",
  "usage_quantity",
  "latency_sum_ms",
  "latency_sample_count",
  "provisional_provider_cost",
  "official_provider_cost_delta",
  "provisional_aiu_micros",
  "official_aiu_micros_delta",
  "unpriced_count",
  "unrated_count",
  "fallback_count",
]);

const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

export async function waitForProjectionCounts(clickhouse, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let actual;
  while (Date.now() < deadline) {
    actual = {};
    for (const [table, count] of Object.entries(expected)) {
      const [physical] = await queryJsonRows(
        clickhouse,
        `SELECT toString(count()) AS row_count
         FROM ${identifier(clickhouse.database)}.${identifier(table)}`,
      );
      const [current] = await queryJsonRows(
        clickhouse,
        `SELECT toString(count()) AS row_count
         FROM ${identifier(clickhouse.database)}.${identifier(`current_${table}`)}`,
      );
      const expectedCurrent =
        table === "application_user_profiles"
          ? (
              await queryJsonRows(
                clickhouse,
                `SELECT toString(uniqExact(tuple(application_id, user_id))) AS row_count
                 FROM ${identifier(clickhouse.database)}.${identifier(table)}`,
              )
            )[0]
          : physical;
      if (expectedCurrent?.row_count !== current?.row_count) {
        throw new Error(`current ClickHouse projection does not match ${table}`);
      }
      actual[table] = Number(
        table === "application_user_profiles" ? current.row_count : physical.row_count,
      );
      if (!Number.isSafeInteger(actual[table]) || actual[table] < 0) {
        throw new Error(`ClickHouse projection count is invalid for ${table}`);
      }
      if (actual[table] > count) {
        throw new Error(
          `current ClickHouse projections exceeded retained-input counts: ${JSON.stringify(actual)}`,
        );
      }
    }
    if (Object.entries(expected).every(([table, count]) => actual[table] === count)) {
      return Object.freeze(actual);
    }
    await sleep(500);
  }
  throw new Error(
    `current ClickHouse projections did not equal retained-input counts: ${JSON.stringify(actual)}`,
  );
}

async function baseFactSummary(clickhouse) {
  const database = identifier(clickhouse.database);
  const [summary] = await queryJsonRows(
    clickhouse,
    `SELECT
       toString((SELECT countIf(is_user_visible_operation = 1)
                 FROM ${database}.current_usage_events_raw)) AS request_count,
       toString((SELECT countIf(notEmpty(attempt_id))
                 FROM ${database}.current_usage_events_raw)) AS attempt_count,
       toString((SELECT countIf(status = 'success')
                 FROM ${database}.current_usage_events_raw)) AS success_count,
       toString((SELECT countIf(status IN ('failure', 'cancelled', 'timeout'))
                 FROM ${database}.current_usage_events_raw)) AS error_count,
       toString((SELECT sum(quantity) FROM ${database}.current_usage_lines)) AS usage_quantity,
       toString((SELECT sum(ifNull(latency_ms, toUInt64(0)))
                 FROM ${database}.current_usage_events_raw)) AS latency_sum_ms,
       toString((SELECT countIf(latency_ms IS NOT NULL)
                 FROM ${database}.current_usage_events_raw)) AS latency_sample_count,
       toString((SELECT sumIf(
                   ifNull(amount_decimal, toDecimal128(0, 18)) * rating_sign,
                   rating_kind = 'provider_cost' AND rating_stage = 'provisional')
                 FROM ${database}.current_rating_events)) AS provisional_provider_cost,
       toString((SELECT sumIf(
                   ifNull(amount_decimal, toDecimal128(0, 18)) * rating_sign,
                   rating_kind = 'provider_cost'
                     AND rating_stage IN ('official', 'correction', 'reversal'))
                 FROM ${database}.current_rating_events)) AS official_provider_cost_delta,
       toString((SELECT sumIf(
                   ifNull(aiu_micros, toInt64(0)) * toInt64(rating_sign),
                   rating_kind = 'aiu' AND rating_stage = 'provisional')
                 FROM ${database}.current_rating_events)) AS provisional_aiu_micros,
       toString((SELECT sumIf(
                   ifNull(aiu_micros, toInt64(0)) * toInt64(rating_sign),
                   rating_kind = 'aiu'
                     AND rating_stage IN ('official', 'correction', 'reversal'))
                 FROM ${database}.current_rating_events)) AS official_aiu_micros_delta,
       toString((SELECT sumIf(
                   toInt64(rating_sign),
                   rating_kind = 'provider_cost'
                     AND rating_stage IN ('unpriced', 'invalid_usage'))
                 FROM ${database}.current_rating_events)) AS unpriced_count,
       toString((SELECT sumIf(
                   toInt64(rating_sign),
                   rating_kind = 'aiu' AND rating_stage IN ('unrated', 'invalid_usage'))
                 FROM ${database}.current_rating_events)) AS unrated_count,
       toString((SELECT countIf(notEmpty(fallback_from))
                 FROM ${database}.current_usage_events_raw)) AS fallback_count`,
  );
  if (summary === undefined) throw new Error("ClickHouse base-fact summary is unavailable");
  return summary;
}

async function aggregateTableSummary(clickhouse, table) {
  const [summary] = await queryJsonRows(
    clickhouse,
    `SELECT ${aggregateMetrics.map((metric) => `toString(sum(${metric})) AS ${metric}`).join(",\n       ")}
     FROM ${identifier(clickhouse.database)}.${identifier(`current_${table}`)}`,
  );
  if (summary === undefined) throw new Error(`ClickHouse ${table} summary is unavailable`);
  return summary;
}

const summariesMatch = (left, right) =>
  aggregateMetrics.every((metric) => left[metric] === right[metric]);

export async function waitForAggregateSemantics(clickhouse, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let summaries;
  while (Date.now() < deadline) {
    const [baseFacts, oneMinute, hourly, daily] = await Promise.all([
      baseFactSummary(clickhouse),
      aggregateTableSummary(clickhouse, "usage_agg_1m"),
      aggregateTableSummary(clickhouse, "usage_agg_hourly"),
      aggregateTableSummary(clickhouse, "usage_agg_daily"),
    ]);
    summaries = {
      base_facts: baseFacts,
      one_minute: oneMinute,
      hourly,
      daily,
    };
    if (
      summariesMatch(baseFacts, oneMinute) &&
      summariesMatch(baseFacts, hourly) &&
      summariesMatch(baseFacts, daily)
    ) {
      return Object.freeze(summaries);
    }
    await sleep(500);
  }
  throw new Error(
    `ClickHouse aggregate projections do not equal base facts: ${JSON.stringify(summaries)}`,
  );
}

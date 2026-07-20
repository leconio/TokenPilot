import type { ReconciliationRunPlan } from "@tokenpilot/reconciliation-engine";

/** Builds the application-bound ClickHouse side of the current dual-store comparison. */
export function clickHouseSnapshotQuery(
  plan: ReconciliationRunPlan,
  conditions: readonly string[],
): string {
  const bucketFunction = plan.runType === "daily" ? "toStartOfDay" : "toStartOfHour";
  return `
    WITH
      line AS (
        SELECT application_id, event_id,
          sumIf(quantity, usage_type IN (
            'uncached_input_token', 'cache_read_input_token',
            'cache_write_input_token', 'embedding_token'
          )) AS input_tokens,
          sumIf(quantity, usage_type IN (
            'cache_read_input_token', 'cache_write_input_token'
          )) AS cached_input_tokens,
          sumIf(quantity, usage_type IN (
            'output_token', 'reasoning_output_token'
          )) AS output_tokens
        FROM current_usage_lines
        GROUP BY application_id, event_id
      ),
      rating AS (
        SELECT application_id, source_event_id AS event_id,
          sumIf(
            toInt64(rating_sign) * ifNull(amount_decimal, toDecimal128(0, 18)),
            rating_kind = 'provider_cost' AND isNotNull(amount_decimal)
          ) AS provider_cost,
          sumIf(
            toInt64(rating_sign) * ifNull(aiu_micros, toInt64(0)),
            rating_kind = 'aiu' AND isNotNull(aiu_micros)
          ) AS aiu_micros,
          argMaxIf(status, tuple(authority_outbox_id, rating_event_id),
            rating_kind = 'provider_cost') AS provider_cost_status,
          argMaxIf(status, tuple(authority_outbox_id, rating_event_id),
            rating_kind = 'aiu') AS aiu_status,
          if(uniqExactIf(price_version_id, rating_kind = 'provider_cost') = 1,
            anyIf(price_version_id, rating_kind = 'provider_cost'), NULL) AS cost_version_id,
          if(uniqExactIf(aiu_rate_version_id, rating_kind = 'aiu') = 1,
            anyIf(aiu_rate_version_id, rating_kind = 'aiu'), NULL) AS aiu_version_id
        FROM current_rating_events
        GROUP BY application_id, source_event_id
    )
    SELECT
      event.application_id AS application_id,
      toString(${bucketFunction}(event.event_time, 'UTC')) AS bucket_start,
      nullIf(event.virtual_model, '') AS virtual_model,
      nullIf(event.model_id, '') AS model_id,
      nullIf(event.model_tag, '') AS model_tag,
      nullIf(event.provider, '') AS provider,
      event.user_id AS user_id,
      uniqExact(event.event_id) AS event_count,
      count() - uniqExact(event.event_id) AS duplicate_projection_count,
      toString(sum(coalesce(line.input_tokens, 0))) AS input_tokens,
      toString(sum(coalesce(line.cached_input_tokens, 0))) AS cached_input_tokens,
      toString(sum(coalesce(line.output_tokens, 0))) AS output_tokens,
      toString(sum(coalesce(rating.provider_cost, 0))) AS provider_cost,
      toString(sum(coalesce(rating.aiu_micros, 0))) AS aiu_micros,
      countIf(rating.provider_cost_status = 'unpriced') AS unpriced_count,
      countIf(rating.aiu_status = 'unrated') AS unrated_count,
      groupUniqArray(100)(event.event_id) AS sample_event_ids,
      if(uniqExact(rating.cost_version_id) = 1,
        any(rating.cost_version_id), '') AS cost_version_id,
      if(uniqExact(rating.aiu_version_id) = 1,
        any(rating.aiu_version_id), '') AS aiu_version_id
    FROM current_usage_events_raw AS event
    LEFT JOIN line
      ON line.application_id = event.application_id AND line.event_id = event.event_id
    LEFT JOIN rating
      ON rating.application_id = event.application_id AND rating.event_id = event.event_id
    WHERE ${conditions.join(" AND ")}
    GROUP BY event.application_id, bucket_start, virtual_model, model_id,
             model_tag, provider, event.user_id
    ORDER BY event.application_id, bucket_start, virtual_model, model_id,
             model_tag, provider, event.user_id
  `;
}

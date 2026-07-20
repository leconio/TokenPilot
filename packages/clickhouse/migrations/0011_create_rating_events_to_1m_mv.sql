-- Current empty-database baseline statement 0011.
-- Applies rating_sign to every stage so corrections and reversals cancel prior additive deltas.
CREATE MATERIALIZED VIEW rating_events_to_1m_mv
TO usage_agg_1m
AS
SELECT
    toDate(event_time) AS event_date,
    toStartOfMinute(event_time) AS bucket_start,
    application_id,
    instance_id,
    environment,
    virtual_model,
    model_id,
    connection_id,
    connection_driver,
    request_model,
    provider,
    attempt_outcome AS status,
    route_reason,
    ifNull(rating_events.usage_type, '') AS usage_type,
    '' AS unit,
    '' AS unit_key,
    ifNull(rating_events.currency, '') AS currency,
    toUInt64(0) AS request_count,
    toUInt64(0) AS attempt_count,
    toUInt64(0) AS success_count,
    toUInt64(0) AS error_count,
    toDecimal128(0, 9) AS usage_quantity,
    toUInt64(0) AS latency_sum_ms,
    toUInt64(0) AS latency_sample_count,
    sumIf(
        ifNull(amount_decimal, toDecimal128(0, 18)) * rating_sign,
        rating_kind = 'provider_cost' AND rating_stage = 'provisional'
    ) AS provisional_provider_cost,
    sumIf(
        ifNull(amount_decimal, toDecimal128(0, 18)) * rating_sign,
        rating_kind = 'provider_cost'
            AND rating_stage IN ('official', 'correction', 'reversal')
    ) AS official_provider_cost_delta,
    sumIf(
        ifNull(aiu_micros, toInt64(0)) * toInt64(rating_sign),
        rating_kind = 'aiu' AND rating_stage = 'provisional'
    ) AS provisional_aiu_micros,
    sumIf(
        ifNull(aiu_micros, toInt64(0)) * toInt64(rating_sign),
        rating_kind = 'aiu'
            AND rating_stage IN ('official', 'correction', 'reversal')
    ) AS official_aiu_micros_delta,
    sumIf(
        toInt64(rating_sign),
        rating_kind = 'provider_cost' AND rating_stage IN ('unpriced', 'invalid_usage')
    ) AS unpriced_count,
    sumIf(
        toInt64(rating_sign),
        rating_kind = 'aiu' AND rating_stage IN ('unrated', 'invalid_usage')
    ) AS unrated_count,
    toUInt64(0) AS fallback_count
FROM rating_events
GROUP BY
    toDate(event_time),
    toStartOfMinute(event_time),
    application_id,
    instance_id,
    environment,
    virtual_model,
    model_id,
    connection_id,
    connection_driver,
    request_model,
    provider,
    attempt_outcome,
    route_reason,
    rating_events.usage_type,
    rating_events.currency;

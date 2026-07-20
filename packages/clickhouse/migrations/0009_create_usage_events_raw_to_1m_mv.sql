-- Current empty-database baseline statement 0009.
-- Deterministically projects request, attempt, status, latency, and fallback partials into 1m.
CREATE MATERIALIZED VIEW usage_events_raw_to_1m_mv
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
    status,
    route_reason,
    '' AS usage_type,
    '' AS unit,
    '' AS unit_key,
    '' AS currency,
    countIf(is_user_visible_operation = 1) AS request_count,
    countIf(notEmpty(attempt_id)) AS attempt_count,
    countIf(status = 'success') AS success_count,
    countIf(status IN ('failure', 'cancelled', 'timeout')) AS error_count,
    toDecimal128(0, 9) AS usage_quantity,
    sum(ifNull(latency_ms, toUInt64(0))) AS latency_sum_ms,
    countIf(latency_ms IS NOT NULL) AS latency_sample_count,
    toDecimal128(0, 18) AS provisional_provider_cost,
    toDecimal128(0, 18) AS official_provider_cost_delta,
    toInt64(0) AS provisional_aiu_micros,
    toInt64(0) AS official_aiu_micros_delta,
    toInt64(0) AS unpriced_count,
    toInt64(0) AS unrated_count,
    countIf(notEmpty(fallback_from)) AS fallback_count
FROM usage_events_raw
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
    status,
    route_reason;

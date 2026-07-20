-- Current empty-database baseline statement 0012.
-- Deterministically rolls every inserted 1m partial into a reduced-dimension hourly partial.
CREATE MATERIALIZED VIEW usage_agg_1m_to_hourly_mv
TO usage_agg_hourly
AS
SELECT
    toDate(usage_agg_1m.bucket_start) AS event_date,
    toStartOfHour(usage_agg_1m.bucket_start) AS bucket_start,
    application_id,
    instance_id,
    environment,
    virtual_model,
    model_id,
    connection_id,
    connection_driver,
    request_model,
    provider,
    usage_type,
    unit,
    unit_key,
    currency,
    sum(request_count) AS request_count,
    sum(attempt_count) AS attempt_count,
    sum(success_count) AS success_count,
    sum(error_count) AS error_count,
    sum(usage_quantity) AS usage_quantity,
    sum(latency_sum_ms) AS latency_sum_ms,
    sum(latency_sample_count) AS latency_sample_count,
    sum(provisional_provider_cost) AS provisional_provider_cost,
    sum(official_provider_cost_delta) AS official_provider_cost_delta,
    sum(provisional_aiu_micros) AS provisional_aiu_micros,
    sum(official_aiu_micros_delta) AS official_aiu_micros_delta,
    sum(unpriced_count) AS unpriced_count,
    sum(unrated_count) AS unrated_count,
    sum(fallback_count) AS fallback_count
FROM usage_agg_1m
GROUP BY
    toDate(usage_agg_1m.bucket_start),
    toStartOfHour(usage_agg_1m.bucket_start),
    application_id,
    instance_id,
    environment,
    virtual_model,
    model_id,
    connection_id,
    connection_driver,
    request_model,
    provider,
    usage_type,
    unit,
    unit_key,
    currency;

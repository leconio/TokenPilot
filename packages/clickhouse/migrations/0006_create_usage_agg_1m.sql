-- Current empty-database baseline statement 0006.
-- Stores additive one-minute partials; queries must SUM again across the complete grouping key.
CREATE TABLE usage_agg_1m
(
    event_date Date,
    bucket_start DateTime64(3, 'UTC'),
    application_id String,
    instance_id String,
    environment LowCardinality(String),
    virtual_model LowCardinality(String),
    model_id String,
    model_tag String,
    provider LowCardinality(String),
    status LowCardinality(String),
    route_reason LowCardinality(String),
    usage_type LowCardinality(String),
    unit LowCardinality(String),
    unit_key String,
    currency LowCardinality(String),
    request_count UInt64,
    attempt_count UInt64,
    success_count UInt64,
    error_count UInt64,
    usage_quantity Decimal(38, 9),
    latency_sum_ms UInt64,
    latency_sample_count UInt64,
    provisional_provider_cost Decimal(38, 18),
    official_provider_cost_delta Decimal(38, 18),
    provisional_aiu_micros Int64,
    official_aiu_micros_delta Int64,
    unpriced_count Int64,
    unrated_count Int64,
    fallback_count UInt64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY
(
    event_date,
    bucket_start,
    application_id,
    instance_id,
    environment,
    virtual_model,
    model_id,
    model_tag,
    provider,
    status,
    route_reason,
    usage_type,
    unit,
    unit_key,
    currency
)
TTL bucket_start + toIntervalDay(90) DELETE
SETTINGS index_granularity = 8192;

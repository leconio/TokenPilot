-- Current empty-database baseline statement 0007.
-- Stores reduced-dimension hourly partials derived only from one-minute insert blocks.
CREATE TABLE usage_agg_hourly
(
    event_date Date,
    bucket_start DateTime64(3, 'UTC'),
    application_id String,
    instance_id String,
    environment LowCardinality(String),
    virtual_model LowCardinality(String),
    model_id String,
    connection_id String,
    connection_driver LowCardinality(String),
    request_model String,
    provider LowCardinality(String),
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
    connection_id,
    connection_driver,
    request_model,
    provider,
    usage_type,
    unit,
    unit_key,
    currency
)
TTL bucket_start + toIntervalDay(730) DELETE
SETTINGS index_granularity = 8192;

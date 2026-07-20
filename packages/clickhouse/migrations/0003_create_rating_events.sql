-- Current empty-database baseline statement 0003.
-- Stores signed rating deltas; PG rating/outbox transactions and sink delivery IDs own idempotency.
CREATE TABLE rating_events
(
    application_id String,
    instance_id String,
    environment LowCardinality(String),
    event_date Date DEFAULT toDate(event_time),
    event_time DateTime64(3, 'UTC'),
    rating_event_id String,
    source_event_id String,
    rating_kind LowCardinality(String),
    rating_stage LowCardinality(String),
    rating_sign Int8,
    request_id String,
    attempt_id String,
    attempt_index UInt8,
    is_final_attempt UInt8,
    operation_id String,
    user_id String,
    virtual_model LowCardinality(String),
    model_id String,
    connection_id String,
    connection_driver LowCardinality(String),
    request_model LowCardinality(String),
    provider LowCardinality(String),
    status LowCardinality(String),
    attempt_outcome LowCardinality(String),
    route_reason LowCardinality(String),
    usage_type LowCardinality(Nullable(String)),
    currency LowCardinality(Nullable(String)),
    amount_decimal Nullable(Decimal(38, 18)),
    aiu_micros Nullable(Int64),
    price_version_id Nullable(String),
    aiu_rate_version_id Nullable(String),
    calculation_version String,
    rating_fingerprint FixedString(71),
    reason String,
    sink_delivery_id String,
    authority_outbox_id UInt64,
    source_outbox_id String,
    inserted_at DateTime64(3, 'UTC') DEFAULT now64(3),
    CONSTRAINT rating_events_kind CHECK rating_kind IN ('provider_cost', 'aiu'),
    CONSTRAINT rating_events_sign CHECK rating_sign IN (-1, 1),
    CONSTRAINT rating_events_status CHECK status IN
        ('provisional', 'official', 'unpriced', 'invalid_usage', 'unrated',
         'disabled', 'not_chargeable', 'reversed', 'superseded', 'unknown'),
    CONSTRAINT rating_events_attempt_outcome CHECK attempt_outcome IN
        ('success', 'failure', 'cancelled', 'timeout', 'unknown'),
    CONSTRAINT rating_events_stage CHECK rating_stage IN
        ('provisional', 'official', 'correction', 'reversal',
         'unpriced', 'invalid_usage', 'unrated', 'disabled', 'not_chargeable'),
    CONSTRAINT rating_events_amount_magnitude CHECK
        ifNull(amount_decimal >= toDecimal128(0, 18), true),
    CONSTRAINT rating_events_aiu_magnitude CHECK ifNull(aiu_micros >= 0, true)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY
(
    application_id,
    instance_id,
    event_date,
    event_time,
    user_id,
    request_model,
    request_id,
    attempt_id,
    rating_event_id
)
SETTINGS index_granularity = 8192;

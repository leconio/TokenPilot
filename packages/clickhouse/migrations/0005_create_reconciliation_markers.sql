-- Current empty-database baseline statement 0005.
-- Records append-only PG-to-ClickHouse reconciliation evidence and signed differences.
CREATE TABLE reconciliation_markers
(
    instance_id String,
    event_date Date DEFAULT toDate(marker_time),
    marker_time DateTime64(3, 'UTC'),
    marker_id String,
    reconciliation_run_id String,
    reconciliation_kind LowCardinality(String),
    status LowCardinality(String),
    range_start DateTime64(3, 'UTC'),
    range_end DateTime64(3, 'UTC'),
    postgres_row_count Int64,
    clickhouse_row_count Int64,
    row_count_delta Int64,
    provider_cost_delta Decimal(38, 18),
    aiu_micros_delta Int64,
    dimensions Map(String, String),
    details_json String,
    source_outbox_id String,
    inserted_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY
(
    instance_id,
    event_date,
    marker_time,
    reconciliation_kind,
    reconciliation_run_id,
    marker_id
)
SETTINGS index_granularity = 8192;

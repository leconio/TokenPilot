-- Current empty-database baseline statement 0004.
-- Appends versioned pipeline state; readers use argMax by pipeline_name instead of FINAL.
CREATE TABLE pipeline_watermarks
(
    pipeline_name String,
    watermark_type LowCardinality(String),
    cursor String,
    watermark_event_time Nullable(DateTime64(3, 'UTC')),
    watermark_outbox_id Nullable(UInt64),
    lag_seconds UInt64,
    status LowCardinality(String),
    error_class String,
    updated_at DateTime64(3, 'UTC'),
    version UInt64,
    event_date Date DEFAULT toDate(updated_at),
    metadata Map(String, String)
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(event_date)
ORDER BY (pipeline_name, watermark_type)
SETTINGS index_granularity = 8192;

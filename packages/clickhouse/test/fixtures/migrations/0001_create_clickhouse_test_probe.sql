CREATE TABLE IF NOT EXISTS clickhouse_test_probe (probe_id UUID, checked_at DateTime64(3, 'UTC')) ENGINE = MergeTree ORDER BY (checked_at, probe_id)

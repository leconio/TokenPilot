-- Current empty-database baseline statement 0022.
-- Stores versioned application-user profiles used by ClickHouse-only segmentation and reporting.
CREATE TABLE application_user_profiles
(
    application_id String,
    user_id String,
    user_record_id String,
    display_user String,
    tags Array(String),
    status LowCardinality(String),
    first_seen_at DateTime64(3, 'UTC'),
    last_seen_at DateTime64(3, 'UTC'),
    profile_updated_at DateTime64(3, 'UTC'),
    user_text_properties Map(String, String),
    user_number_properties Map(String, Float64),
    user_boolean_properties Map(String, UInt8),
    user_datetime_properties Map(String, DateTime64(3, 'UTC')),
    user_enum_properties Map(String, String),
    user_text_list_properties Map(String, Array(String)),
    properties_json String CODEC(ZSTD(3)),
    profile_version UInt64,
    sink_delivery_id String,
    source_outbox_id String,
    inserted_at DateTime64(3, 'UTC') DEFAULT now64(3),
    CONSTRAINT application_user_profiles_status CHECK status IN ('active', 'blocked')
)
ENGINE = ReplacingMergeTree(profile_version)
PARTITION BY cityHash64(application_id) % 16
ORDER BY (application_id, user_id)
SETTINGS index_granularity = 8192;

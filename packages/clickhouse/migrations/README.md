# ClickHouse current baseline

This directory is the one current empty-database baseline. Its 23 numbered SQL
files are one indivisible schema definition, not an upgrade chain. One literal
`CREATE` statement is kept in each file because the official HTTP client runs
one statement per request. The runner hashes every exact UTF-8 file and records
the complete set in `clickhouse_schema_migrations`.

The only accepted states are:

- an empty database, where the complete baseline can be installed once; or
- a complete installation whose history names and checksums, object names, and
  object engines exactly match this directory, where a second `up` is a no-op.

A database with a partial history, a changed checksum, an unexpected legacy
object, a missing object, or an object using the wrong engine is rejected. Do
not repair migration history or try to finish the installation. Delete and
recreate the disposable ClickHouse database, then install this baseline again.

The runner lock and `clickhouse_schema_migrations` are internal objects. All 23
application objects are declared explicitly by the SQL files. There is no
`analytics_read_targets` table, generation discovery, version-suffixed physical
table lookup, or `merge()` table-function boundary.

## Current read boundary

The sink writes the fixed physical tables, including `usage_events_raw`,
`usage_lines`, `rating_events`, `application_user_profiles`, watermarks,
reconciliation markers, and aggregate tables. Reporting reads fixed `current_*`
views. Telemetry current views are simple `SELECT *` boundaries; the user-profile
view selects the latest version with `argMax`. Queries never discover or combine
other physical targets.

## Write and aggregation contract

The sink writes `usage_events_raw` and `usage_lines` explicitly. There is no
materialized view that parses JSON payloads into usage lines. PostgreSQL
Registry/Outbox state plus deterministic `event_id`, `usage_line_id`,
`rating_event_id`, and `sink_delivery_id` values form the idempotency boundary;
ordinary ClickHouse merges are not the source of truth for delivery
deduplication.

The sink removes the trusted-context signature and configured secret fields
before serializing `usage_events_raw.raw_payload`. ClickHouse retains only the
signature-validation result and key version as queryable columns.

Materialized views perform deterministic projection and addition. Aggregate
tables use `SummingMergeTree`, so readers filter by a bounded time range and
`SUM` metrics over the complete report grouping key instead of depending on
background merges or `FINAL`.

`rating_events.rating_sign` is `1` or `-1`. Provisional values feed provisional
columns. Direct official values, correction deltas, and reversal deltas feed
official-delta columns. The current realtime estimate is the sum of provisional
and official-delta columns. When provisional data exists, the sink emits
`official - provisional` as the correction and does not also emit the full
official amount for that transition.

`pipeline_watermarks` is append-only and ordered by a monotonic row version.
Read its latest state with
`argMax(tuple(watermark_type, cursor, watermark_event_time,
watermark_outbox_id, lag_seconds, status, error_class, updated_at),
tuple(version, updated_at)) GROUP BY pipeline_name`; do not use `FINAL` in
online queries.

## Retention changes during development

The committed defaults are raw 90 days, usage lines 180 days, one-minute 90
days, hourly 730 days, and daily 1825 days. Watermarks, rating events, and
reconciliation markers have no automatic TTL.

Inspect the current literal definition in `system.tables.create_table_query`.
To change retention during development, edit the appropriate current baseline
file, review the storage impact, delete and recreate the disposable database,
and install the whole baseline. For example, the edited table definition may
contain `TTL event_time + toIntervalDay(120) DELETE`. Runtime environment
variables are never interpolated into schema SQL.

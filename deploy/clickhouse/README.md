# ClickHouse deployment

ClickHouse is a required analytics/query datastore. PostgreSQL remains the official Cost, AIU,
Quota, and journal authority, while every analysis query uses the ClickHouse projection. The main
Compose file starts both datastores and runs the ClickHouse migration job before API and Worker are
eligible to become ready. `docker-compose.clickhouse.yml` is retained only for the isolated
ClickHouse schema acceptance script; it is not an opt-in application mode.

Use three independently generated secrets from an external environment file:

- bootstrap `default` password, restricted to loopback and initialization;
- `ai_control_migrator`, limited to DDL in the application database;
- `ai_control_app`, limited to runtime `SELECT` and `INSERT` in the application
  database plus read-only `system.disks` capacity metadata for the storage
  utilization metric.

The default resource envelope is a 4 GiB / 2 CPU limit with a 1 GiB / 0.5 CPU
reservation. For a small development dataset, allocate at least 2 GiB memory,
two CPU cores, and persistent space for both data and logs. Production sizing
must be based on ingestion volume, TTL, merge pressure, and query concurrency.

The database network remains internal. The test override publishes HTTP only on
`127.0.0.1` and must only be used in an isolated remote acceptance project.
Application traffic never uses `default`, and secrets must not be committed or
placed in command-line arguments.

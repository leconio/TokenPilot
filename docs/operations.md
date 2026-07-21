# Operations and recovery

[中文](operations.zh-CN.md)

## Daily health checks

```bash
docker compose ps
curl --fail http://127.0.0.1:8080/healthz
curl --fail http://127.0.0.1:8080/health/ready
```

Liveness shows that the process is running. Readiness also requires PostgreSQL, Redis, and
ClickHouse. A readiness failure is a service incident, even if an SDK or external LiteLLM can still
reach its model service with the last applied configuration.

Review these Web pages during an incident:

- **Connections** for heartbeat age and Connector backlog;
- **Activity** for configuration changes;
- **Model cost** and **AIU analytics** for unpriced, unrated, or unresolved coverage;
- **Releases** for the exact runtime configuration acknowledged by each Connector.

## Logs

```bash
docker compose logs --since 30m api worker scheduler web caddy
docker compose logs --since 30m postgres redis clickhouse
```

Logs must not contain prompt, response, secret, or raw user identity values. Keep detailed logs only
in a restricted operational system with a documented retention period.

## Backups

Back up the configuration and analytics stores in the same operational window:

```bash
./scripts/backup-postgres.sh --output /secure/backups
./scripts/operations/backup-clickhouse.sh --output /secure/backups
./scripts/operations/backup-redis.sh --output /secure/backups
```

Store the generated manifests and checksums with the backup. Encrypt the backup location and run a
restore test in an isolated project before relying on it.

The LiteLLM Connector spool is local durable transport state. Back it up only while the Connector is
stopped or through its SQLite-safe backup command:

```bash
python scripts/connector-spool-admin.py backup \
  --spool /var/lib/tokenpilot/litellm-spool.sqlite3 \
  --output /secure/backups/litellm-spool.sqlite3
```

## Restore drill

Restore into a new isolated Compose project with empty volumes, not the active project. Restore all
three stores with the documented scripts, then check:

1. all services become ready;
2. PostgreSQL configuration and quota fingerprints match;
3. ClickHouse row identities and aggregate totals match;
4. Redis has no foreign leases or stale pause token;
5. reconciliation reports zero unexplained differences;
6. the isolated project can be removed without touching the active project.

## Dependency outages

### PostgreSQL unavailable

Configuration writes, rating decisions, quota decisions, and readiness fail. Do not publish a policy
or attempt a manual dual write. Restore PostgreSQL, verify migrations and ownership, then let durable
queues resume.

### Redis unavailable

Queues and reservation coordination stop. Readiness fails. Restore Redis before restarting workers;
verify that leases and reservations converge exactly once.

### ClickHouse unavailable

Reports return unavailable and the Worker retains projection work in PostgreSQL Outbox. Restore
ClickHouse, verify the current schema, resume the sink, and confirm the backlog drains to zero. There
is no PostgreSQL report fallback.

## Fresh ClickHouse rebuild

Use the rebuild tool only for an isolated database that belongs to the current test. It pauses the
sink, replaces the conflicting schema, replays retained PostgreSQL Outbox rows, and checks projected
rows and totals. Delivery resumes only after those checks pass. If a check fails, delivery stays
paused.

## Common alerts

| Alert                             | First check                                                  |
| --------------------------------- | ------------------------------------------------------------ |
| Connector heartbeat stale         | LiteLLM process, key status, network, spool integrity        |
| Connector backlog growing         | API readiness, spool capacity, ingest errors                 |
| Unpriced Provider usage           | Source amount, real-model resolution, matching fallback rule |
| Unrated AIU usage                 | Published AIU card and inherited rate coverage               |
| ClickHouse sink lag               | ClickHouse readiness, Outbox leases, pause owner             |
| Quota reservation expiry spike    | Client cancellation path and request timeout                 |
| Configuration acknowledgement lag | Connector instance and exact published revision              |
| Reconciliation difference         | Export the redacted difference before repair                 |

## Secret rotation

Create a new service key before disabling the old one. Update clients, confirm the new key is in use,
then disable the old key. Signing-key rotation permits one previous key for a bounded overlap; remove
it after every client has refreshed and the maximum clock-skew window has passed.

## Safe shutdown

```bash
docker compose down
```

This retains volumes. Use `--volumes` only for a confirmed disposable development project. Record
the project name and volume list before deletion.

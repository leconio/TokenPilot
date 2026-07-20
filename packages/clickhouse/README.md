# `@tokenpilot/clickhouse`

Official ClickHouse Node client integration, typed operations, health checks,
watermarks, and a fresh-only current schema baseline for the rebuildable realtime
analytics projection. PostgreSQL remains authoritative for ratings, journals,
AIU usage, remaining quota, and settlement.

## Layout

- `src/client/`: official client singleton, bounded read retry, query timeout,
  and confirmed batched inserts.
- `src/metrics/`: low-cardinality operation metrics that never contain SQL,
  query parameters, row values, credentials, or error messages.
- `src/migration/`: baseline discovery, complete-install checksum verification,
  concurrency lock, and
  `status`/`up`/`verify` implementation.
- `migrations/`: the one current empty-database baseline, stored as one literal
  ClickHouse `CREATE` statement per numbered file.
- `src/sink-readiness.ts`: non-throwing platform probe plus the strict Sink
  startup gate.
- `src/watermarks.ts`: append-only pipeline watermark writes and `argMax`
  reads without `FINAL`.

Every production source file stays below the repository's 400-line gate, and
every test stays below its 500-line gate.

## Runtime operations

Create the application singleton once and wrap it with typed operations:

```ts
const config = loadClickHouseConfig(process.env, { role: "application" });
const client = getClickHouseClient(config, "application");
const operations = new ClickHouseOperations(client, config, metricsSink);
```

`queryRows` enforces a client abort timeout, a ClickHouse execution timeout,
parameter binding, and `readonly=1`. It retries only a bounded allowlist of
transient read failures. `insertRows` slices rows by
`CLICKHOUSE_INSERT_BATCH_SIZE`, enables configured asynchronous insertion, and
always sends `wait_for_async_insert=1`. It never retries an uncertain write;
the PostgreSQL Outbox and Sink delivery state own replay safety.

The official client's free-form internal logger is disabled to prevent result
or error bodies from reaching logs. The structured metrics sink is the sole
operation telemetry channel and contains only query id, counts, duration,
outcome, and a bounded error class.

The process client registry owns one official client per credential role.
Changing active connection settings is rejected; graceful shutdown closes the
registry.

## Configuration

Application and migration users are distinct, and `default` is rejected. URLs
must not embed credentials. `http://` and `https://` are supported, with
`CLICKHOUSE_SECURE` required to match the protocol.

Relevant bounds include:

- `CLICKHOUSE_REQUEST_TIMEOUT_MS` (default `10000`)
- `CLICKHOUSE_MAX_OPEN_CONNECTIONS` (default `10`)
- `CLICKHOUSE_INSERT_BATCH_SIZE` (default `1000`)
- `CLICKHOUSE_INSERT_FLUSH_MS` (default `1000`)
- `CLICKHOUSE_ASYNC_INSERT` (default `true`)
- `CLICKHOUSE_WAIT_FOR_ASYNC_INSERT` (must be `true` with async inserts)
- `CLICKHOUSE_SAFE_RETRY_ATTEMPTS` (default `3`, reads only)
- `CLICKHOUSE_SAFE_RETRY_BASE_DELAY_MS` (default `100`)

## Current baseline and Sink readiness

After building the package, run migrations explicitly before enabling the
Sink:

```sh
pnpm --filter @tokenpilot/clickhouse build
pnpm --filter @tokenpilot/clickhouse clickhouse status
pnpm --filter @tokenpilot/clickhouse clickhouse up
pnpm --filter @tokenpilot/clickhouse clickhouse verify
```

The numbered SQL files are one indivisible baseline, not incremental upgrades.
The runner installs all of them only when the database has no application
objects and no history table. A complete installation with matching history,
object names, and engines is a no-op. Partial history, missing objects, changed
checksums, wrong engines, and unexpected old objects are rejected with an
instruction to delete and recreate the disposable database. The runner never
repairs, resumes, upgrades, or downgrades a schema.

An atomic lock-table creation prevents concurrent installers. A crashed lock
requires explicit operator verification and cleanup. Fixed `current_*` views
select directly from fixed current tables; there is no generation registry,
physical-table discovery, or regex `merge()` read path.

`checkClickHouseSinkReadiness` returns degradation without throwing so API and
model-request paths stay available. Only the ClickHouse Sink startup path calls
`requireClickHouseSinkReadiness`, which blocks the Sink when health or migration
verification fails.

## Verification

Safe local checks do not require ClickHouse:

```sh
pnpm --filter @tokenpilot/clickhouse test
pnpm --filter @tokenpilot/clickhouse typecheck
pnpm --filter @tokenpilot/clickhouse build
```

The integration suite is intentionally opt-in and must target the disposable
remote ClickHouse on the deployment host. It covers empty-schema installation,
least privilege, 10,000-row confirmed batching, materialized views, signed
official correction deltas, TTL discovery, parameterized Map queries, and query
timeout behavior.

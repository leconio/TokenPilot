# API application

The NestJS/Fastify API exposes the current unversioned machine, runtime, administration, reporting,
reconciliation, Web-authentication, health, metrics, and OpenAPI surfaces. It accepts only canonical
Contracts and recursively rejects or removes Provider keys, authorization, cookies, prompts,
responses, messages, request bodies, and content-bearing exceptions.

## Responsibilities

- `POST /usage-events/batch` commits one immutable Registry identity and one Inbox payload in the
  same PostgreSQL transaction. Identical retries are duplicates; the same event ID with a different
  canonical payload hash is a conflict.
- Connector heartbeat and Policy Snapshot/acknowledgement routes serve trusted machine clients.
- Runtime routes expose the current snapshot, trusted subject dimensions, quota decisions, and AIU
  reservation lifecycle.
- Administration routes manage catalog, routing, Provider Price, AIU, quota, reports,
  reconciliation, jobs, dead-letter evidence, and one-time service keys.
- Web sessions use strict cookies, CSRF/origin checks, and access-plane scope enforcement.
- Health, readiness, metrics, and OpenAPI describe the same registered runtime surface.

Within a ready deployment, batch acknowledgement waits only for the PostgreSQL Registry/Inbox
transaction, not synchronous ClickHouse delivery or complete settlement. Worker owns durable
normalization, rating, quota, authority commit, and Outbox delivery. PostgreSQL authority remains
durable during a ClickHouse incident, but API/report readiness fails until PostgreSQL, Redis, and
ClickHouse recover.

See [`docs/api.md`](../../docs/api.md) for the route families and
[`docs/api.md`](../../docs/api.md) and [`docs/concepts.md`](../../docs/concepts.md) for wire rules.

## Development

The API requires existing PostgreSQL, Redis, and ClickHouse endpoints. Do not start local containers on the
developer Mac. Point development or integration commands only at an isolated remote environment:

```bash
DATABASE_URL='postgresql://<isolated>' \
REDIS_URL='redis://<isolated>' \
CLICKHOUSE_URL='http://<isolated>' \
pnpm --filter @tokenpilot/api dev
```

Never aim datastore or test URLs at production. The integration suite creates and drops test state
and may flush its designated Redis database.

Source-only checks are:

```bash
pnpm --filter @tokenpilot/api typecheck
pnpm --filter @tokenpilot/api build
```

Run `pnpm test:api` only with authorized isolated dependencies. Final real-stack acceptance uses
`REMOTE_DOCKER_ACCEPTANCE=1 pnpm acceptance:remote` on the authorized Linux host.

## Security

Machine clients use separate ingestion/runtime and administration keys with least-privilege scopes.
Raw keys are returned once and stored only as hashes. Every response carries a request identifier;
errors use the privacy-safe `ApiError` envelope and never echo rejected values.

Exact model-spend and AIU values remain decimal strings at the HTTP boundary. Provider Cost and
quota corrections are append-only journal operations. The Control Plane does not synchronously
authorize, proxy, delay, or reject model traffic.

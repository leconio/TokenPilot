# Database package

This package owns TokenPilot's PostgreSQL schema, Prisma client, empty-database migration, and
minimal instance seed. It never starts PostgreSQL or a container runtime.

PostgreSQL is the source of truth for applications, members, API keys, call connections, real
models, virtual-model routing, property definitions, application users, AIU allowances, durable
ingestion, runtime configuration, and audit history. ClickHouse stores rebuildable analytics
projections; Redis runs queues and short-lived coordination.

## Fresh development database

The repository intentionally carries one current migration baseline. It does not upgrade or repair
an older development schema. Point the following commands at a disposable empty PostgreSQL 16
database:

```bash
DATABASE_URL=postgresql://... pnpm --filter @tokenpilot/db db:migrate
DATABASE_URL=postgresql://... pnpm --filter @tokenpilot/db db:seed
```

If the development schema changes, recreate the disposable database and apply the current baseline.
Never aim migration or integration-test credentials at production.

The seed only creates the singleton instance settings from environment values. It does not invent
applications, models, users, usage, cost, AIU consumption, quotas, queue records, or analytics data.
Running it repeatedly is safe.

After Setup creates an application, an explicitly requested, secret-free routing example can be
added idempotently with:

```bash
TOKENPILOT_EXAMPLE_APPLICATION_SLUG=my-application \
  pnpm --filter @tokenpilot/db db:seed:example
```

This separate command stores only credential environment-variable names. It never runs as part of
the normal seed or Compose startup.

## Application boundaries

Application-owned records carry `application_id`. Composite keys and foreign keys keep models,
virtual models, users, AIU balances, usage events, outbox messages, failures, reports, and runtime
configuration inside the same application. An application user is uniquely identified by
`(application_id, external_id)`, so the same external `user_id` may exist independently in many
applications.

## Checks

Static checks require no local database or container:

```bash
pnpm --filter @tokenpilot/db generate
pnpm --filter @tokenpilot/db typecheck
```

Database acceptance runs against a disposable PostgreSQL instance. It applies the migration twice,
seeds twice, checks the schema and isolation constraints, and then removes the test database. In this
workspace that database is provided by the remote deployment host.

The Better Auth `user`, `session`, `account`, `verification`, and `rate_limit` tables are also owned
here. See [concepts](../../docs/concepts.md) and
[development](../../docs/development.md) before changing the schema.

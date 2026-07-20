# Development and architecture

[中文](development.zh-CN.md)

## Repository layout

- `apps/api`: HTTP API, authentication, configuration, reports, and runtime snapshots.
- `apps/worker`: durable usage processing, pricing, AI Unit, projection, and reconciliation.
- `apps/scheduler`: recurring maintenance and reconciliation schedules.
- `apps/web`: Next.js console using shadcn/ui, Radix, React Query, and Playwright.
- `packages`: focused domain libraries, Contracts, PostgreSQL client, and ClickHouse client.
- `connectors/litellm`: Python callback, redaction, spool, sender, and heartbeat.
- `sdks/node`, `sdks/python`: trusted context, policy cache, routing, and quota helpers.
- `deploy`: Compose implementation, images, ingress, ClickHouse bootstrap, and observability.
- `scripts`: source quality, backup, performance, release, and remote acceptance tools.

Generated files stay beside their owning package. Build output, caches, evidence, and local runtime
state are ignored and must not be committed.

## Data flow

```text
LiteLLM callback
  → local SQLite spool
  → API Registry and Inbox transaction
  → Worker model resolution
  → Provider cost and AI Unit decisions
  → PostgreSQL journals and Outbox transaction
  → ClickHouse projections
  → Web reports
```

Every boundary has a stable idempotency key. Worker leases use fencing tokens. Replays retain the
original authority sequence so an older decision cannot replace a newer terminal decision.

## Local source setup

```bash
corepack enable
corepack install --global pnpm@11.13.0
pnpm install --frozen-lockfile
uv sync --project connectors/litellm --locked --all-groups
uv sync --project sdks/python --locked --all-groups
```

The source-only workstation does not need a container runtime. Database integration and complete
deployment acceptance run on an isolated Linux host.

## Quality gates

Run independent gates as a batch and collect the complete failure list before fixing common causes:

```bash
pnpm check:structure
pnpm check:versions
pnpm check:contracts
pnpm check:docs
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @tokenpilot/web test:e2e
pnpm test:operations
pnpm test:release
```

`pnpm check:structure` enforces formal directories and file-size limits. Contracts are generated
from one TypeScript authority and compared with Python, SDK, Connector, examples, and fixtures.

## Database tests

PostgreSQL, Redis, and ClickHouse are mandatory for integration tests. Use new empty databases and
isolated Redis database numbers. Do not point tests at a shared or production service. The remote
acceptance runner creates a unique Compose project, checks the protected production fingerprint
read-only, executes every available stage, records PASS/FAIL/BLOCKED, and removes only labeled
isolated resources.

Remote acceptance is intentionally host-bound. Set `ACCEPTANCE_HOST_ADDRESS` to an address assigned
to the dedicated Linux host before running it. If dependency downloads require a proxy, set
`ACCEPTANCE_DEPENDENCY_PROXY`; use `ACCEPTANCE_NO_PROXY` to provide site-specific bypass entries.
These values belong in the operator environment and must not be committed.

## Web conventions

- Use existing shadcn/ui components under `apps/web/components/ui`.
- Keep forms short; derive identifiers and defaults when the server can do so safely.
- Put advanced fields behind an explicit disclosure.
- Every page needs loading, empty, permission, and dependency-error states.
- User-facing text must be available in Chinese and English.
- Do not expose datastore names or internal event terminology in normal error messages.

## Adding a Contract field

1. Change the canonical schema in `packages/contracts`.
2. Add valid and invalid fixtures.
3. Generate JSON Schema and Python models.
4. Update Connector and SDK parsing.
5. Add persistence and ClickHouse projection only when the field has a defined owner.
6. Run `pnpm check:contracts` and parity tests.

## Security boundaries

The model-content path ends at LiteLLM. TokenPilot code reviews should reject new fields that can
carry prompts, responses, tool arguments, or Provider credentials. Secrets must never appear in
test evidence. Runtime containers use fixed non-root identities, read-only root filesystems, dropped
capabilities, and private database networks.

# Development and architecture

[中文](development.zh-CN.md)

## Repository layout

- `apps/api`: HTTP API, authentication, configuration, reports, and runtime snapshots.
- `apps/worker`: durable usage processing, pricing, AI Unit, projection, and reconciliation.
- `apps/scheduler`: recurring maintenance and reconciliation schedules.
- `apps/web`: Next.js console using shadcn/ui, Radix, React Query, and Playwright.
- `packages`: domain libraries, contracts, and database clients.
- `connectors/litellm`: Python callback, redaction, spool, sender, and heartbeat.
- `sdks/node`, `sdks/python`: request context, policy cache, routing, and quota helpers.
- `deploy`: Compose implementation, images, ingress, ClickHouse bootstrap, and observability.
- `scripts`: source quality, backup, performance, release, and remote acceptance tools.

Generated files stay in their package. Do not commit build output, caches, test evidence, or local
runtime state.

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

Each step has a stable idempotency key. Worker leases use fencing tokens. A replay keeps the original
decision order, so an old decision cannot replace a newer final decision.

## Local source setup

```bash
corepack enable
corepack install --global pnpm@11.13.0
pnpm install --frozen-lockfile
uv sync --project connectors/litellm --locked --all-groups
uv sync --project sdks/python --locked --all-groups
```

The source-only workstation does not need a container runtime. Database integration and deployment
acceptance run on an isolated Linux host.

## Quality gates

Run all applicable checks before fixing failures. This makes shared causes easier to see:

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
from one TypeScript source and compared with Python, SDK, Connector, examples, and fixtures.

## Database tests

Integration tests require PostgreSQL, Redis, and ClickHouse. Use empty databases and an isolated
Redis database number. Do not point tests at shared or production services. The remote acceptance
runner creates a named Compose project, reads the protected deployment fingerprint without changing
it, runs the available stages, and removes only resources labeled for that test run.

Remote acceptance runs on a designated host. Set `ACCEPTANCE_HOST_ADDRESS` to an address assigned to
the dedicated Linux host before running it. If dependency downloads require a proxy, set
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

Model content stays between the calling process and the model service. TokenPilot usage events must
not add fields that can carry prompts, responses, tool arguments, or provider credentials. Test
evidence must not contain secrets. Runtime containers use fixed non-root users, read-only root
filesystems, reduced capabilities, and private database networks.

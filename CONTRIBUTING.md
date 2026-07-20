# Contributing

Thanks for helping improve TokenPilot. Before starting a substantial change, open or join an issue
so the problem, scope, and compatibility impact can be discussed. Small documentation fixes and
clearly scoped bug fixes can go directly to a pull request. Architectural boundary changes should
include an ADR proposal.

TokenPilot is in active `0.x` development. Public APIs and schemas can still change, but breaking
changes must be called out clearly in the pull request and changelog. Use Conventional Commits and
keep Contract changes with their generated artifacts, fixtures, and cross-language parity updates.

Follow the [development and source-layout guide](docs/development.md). Do not
place ad-hoc implementation files at the repository root or add new source-size debt. Web interfaces
must compose the shadcn/ui primitives in `apps/web/components/ui` instead of recreating common UI
controls.

Before opening a pull request, run:

```bash
pnpm check:structure
pnpm check:docs
pnpm lint
pnpm typecheck
pnpm test
pnpm test:db
pnpm build
uv run --project connectors/litellm ruff check connectors/litellm
uv run --project connectors/litellm mypy connectors/litellm/src connectors/litellm/tests connectors/litellm/scripts
```

Run the checks relevant to your change at minimum; maintainers may require the complete suite for
cross-cutting changes. Database, browser, and container acceptance requires an isolated Linux host.

Never commit Provider keys, production credentials, prompts, model responses, real customer data,
Connector spool files, database dumps, or machine-specific deployment details. Use documentation
addresses and synthetic identifiers in examples and tests.

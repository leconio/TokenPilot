# Changelog

TokenPilot follows Semantic Versioning and Conventional Commits. This file describes only the
current product behavior kept in the repository.

## 0.2.0 — 2026-07-18

### Added

- Multi-application isolation for configuration, keys, events, users, models, AIU, routing,
  reports, and audit records.
- Application-scoped users populated automatically from reported `user_id` and optional
  `display_user`, with manual administration, tags, groups, quota reset, and access suspension.
- LiteLLM-tag models with reported-cost-first conditional fallbacks and independent AIU rates for
  each usage dimension.
- Virtual models with conditional routes, ordered fallbacks, temporary rules, signed runtime
  snapshots, and connector acknowledgements.
- Typed event and user properties, ClickHouse-backed event search, saved reports, dashboards, and
  user-group analysis.
- Node and Python SDKs, a LiteLLM connector, and a native Python example for reporting usage from a
  Mac without local containers.
- Exact or estimated source-cost reporting from LiteLLM, manual SDK events, and Node/Python
  provider adapters.

### Architecture

- PostgreSQL is authoritative for configuration, users, model cost, AIU quotas, ledgers, audit,
  and reconciliation state.
- ClickHouse is the required analytical store for events, searches, groups, and reports.
- Redis coordinates application-scoped jobs, leases, and short-lived runtime state.
- PostgreSQL Inbox and Outbox records provide the durable hand-off to ClickHouse.
- A new installation starts from one current empty-database schema; no database compatibility or
  downgrade path is maintained during development.

### Security

- Application identity comes from the application key and cannot be selected by an event body.
- Provider keys stay in the user's LiteLLM environment.
- Prompt and response bodies are excluded by default, while sensitive typed fields are masked and
  permission-controlled.
- Cross-application object references, runtime snapshots, exports, and machine keys are rejected.

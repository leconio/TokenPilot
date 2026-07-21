# Changelog

TokenPilot uses Semantic Versioning and Conventional Commits. This file lists the behavior in the
current source tree.

## 0.2.0, 2026-07-18

### Added

- Separate configuration, keys, events, users, models, AIU, routing, reports, and audit records for
  each application.
- Application users created from reported `user_id` and optional `display_user`, with manual
  editing, tags, groups, allowance reset, and blocking.
- Connection-backed real models for LiteLLM, OpenAI-compatible services, and Anthropic, with
  reported-cost-first conditional fallbacks and independent AIU rates for each usage dimension.
- Virtual models with conditions, ordered fallbacks, temporary rules, signed runtime configuration,
  and client acknowledgements.
- Typed event and user properties, ClickHouse-backed event search, saved reports, dashboards, and
  user-group analysis.
- Node and Python SDKs, a LiteLLM connector, and a native Python example for reporting usage from a
  Mac without local containers.
- Exact or estimated source-cost reporting from LiteLLM, manual SDK events, and Node/Python
  provider adapters.

### Architecture

- PostgreSQL stores configuration, users, model cost, AIU allowances, journals, audit, and
  reconciliation state.
- ClickHouse stores the data used by event search, user groups, and reports.
- Redis coordinates jobs, leases, and short-lived runtime state.
- PostgreSQL Inbox and Outbox records provide the durable handoff to ClickHouse.
- A new installation starts from one current empty-database schema; no database compatibility or
  downgrade path is maintained during development.

### Security

- Application identity comes from the application key and cannot be selected by an event body.
- Provider keys stay in the application or LiteLLM runtime environment.
- Prompt and response bodies are excluded by default, while sensitive typed fields are masked and
  permission-controlled.
- Cross-application object references, runtime snapshots, exports, and machine keys are rejected.

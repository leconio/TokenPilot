# Project guide

[中文](guide.zh-CN.md)

## Purpose

Provider dashboards show account-level usage. An application often needs a separate view by user,
feature, and model attempt. It may also need a stable model name, its own usage unit, and a per-user
allowance. TokenPilot stores those rules and results in one place.

Applications can use the Node SDK, Python SDK, LiteLLM Connector, or manual reporting. The SDKs and
Connector report model attempts without prompt or response content. They keep a local queue for
temporary upload failures and cache the last valid routing configuration.

## Main parts

### Applications and users

Each application has its own home page, users, fields, keys, reports, allowances, and published
routing. Calls require `user_id`; `display_user` is the optional name shown in the console. A user
can arrive with the first usage event or be added manually. Typed custom fields can store values
such as `next_action`, `parse_context`, or voice mode.

### Connections and real models

A connection records how the calling process reaches LiteLLM or a provider API. It stores the
protocol, endpoint, capabilities, and the name of a local credential variable. It does not store the
credential value. A real model joins that connection to the model name sent in the request. Cost
rules and AI Unit rates belong to the real model.

### Virtual models and routing

A virtual model is the stable name used by application code, such as `fast-text` or
`deep-reasoning`. It points to real models and defines their order, weights, schedules, user
conditions, and temporary switches. Publishing creates a fixed revision. Calling processes report
which revision they applied.

The application keeps the same virtual model name when a policy changes the provider or real model.
Image or audio requests use only candidates that declare the required capability.

### Analytics and saved reports

The console shows calls, fallback attempts, Token usage, latency, errors, provider cost, and AI Unit.
Filters can combine built-in fields with typed custom fields. Saved analyses can be placed on the
current application's dashboard. Reports read ClickHouse; configuration and operational state stay
in PostgreSQL.

### Provider cost, AI Unit, and user allowance

Provider cost is the amount charged for a model attempt. TokenPilot uses the amount reported by the
caller when present. Otherwise, the first matching cost rule calculates a fallback. AI Unit uses a
separate rate card for product usage and allowances. Editing a cost rule does not change AI Unit.
Missing rules are shown as unpriced or unrated usage, not zero.

Each application user can have an AI Unit allowance. Enforcement reserves an estimate before a call
and settles the actual amount afterward. If no call starts, it releases the reservation. Blocking a
user or resetting an allowance writes an audit record and keeps the usage history.

## Boundaries

- TokenPilot needs messages only in the calling process to invoke the Provider; reporting excludes
  prompt and response bodies.
- Provider credentials stay in runtime environment variables or the team's existing secret store.
- SDK and Connector queues use SQLite and stable event IDs for retries.
- PostgreSQL and ClickHouse are both required: they have distinct configuration and analytics jobs.
- A rejected publication never replaces the last successfully applied policy.

## Suggested setup order

1. Deploy TokenPilot and complete first-run setup.
2. Create an application and its application key.
3. Define the event and user fields that the application is allowed to report.
4. Add a connection and its real models, configure cost fallbacks if needed, and publish AI Unit rates.
5. Create a virtual model, simulate representative requests, and publish it.
6. Integrate the Node SDK, Python SDK, or LiteLLM Connector and verify a real call.
7. Review users, attempt chains, cost, AI Unit, and saved reports.
8. Grant user allowances in measurement mode, then enable warnings or enforcement after identity
   and rate coverage are complete.

Check the first real call before enabling allowance enforcement. Missing cost or AI Unit rules stay
visible and should be fixed before they are used for decisions.

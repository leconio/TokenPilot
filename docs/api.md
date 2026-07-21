# HTTP API

[中文](api.zh-CN.md)

The HTTP API receives usage, manages applications, serves reports, and publishes configuration to
SDKs and Connectors. Model requests go from the Node SDK, Python SDK, or LiteLLM to the configured
model service. TokenPilot has no model-completion endpoint.

## Authentication and application binding

Server clients send `Authorization: Bearer <application-key>`. A key belongs to one application, is
shown only when created, and is stored as a hash. Create separate keys for these uses:

- ingestion: `usage:write` and Connector heartbeat;
- runtime: configuration read, acknowledgement, and AIU reservation operations;
- administration: application resources, reports, audit, and operational actions.

The API derives `application_id` from the key. A caller cannot choose or override it in an event.
All resource routes also contain `:applicationSlug`; a mismatch between the URL and key is rejected.
The Web console uses an authenticated cookie session plus CSRF protection for mutations.

## Usage ingestion

`POST /usage-events/batch` accepts a batch of usage events without model content. `user.user_id` is
required and `user.display_user` is recommended. A successful event automatically creates or
updates that user inside the key's application. The same `user_id` in another application is an
independent user.

An event can include time, request and attempt IDs, client and application versions, model identity,
measured usage, result fields, typed custom properties, and an optional `source_cost` reported by
the provider client. `source_cost` contains a non-negative decimal `amount`, a three-letter
`currency`, and `is_estimated`. The API rejects or removes prompts, responses, messages, tool
arguments, cookies, authorization headers, and provider credentials before storage.

Idempotency is scoped by `application_id + event_id`:

- identical content returns `duplicate`;
- different content under the same identity returns `conflict`;
- one invalid item does not discard valid siblings in the batch.

## Application administration

The following families are bound to `/applications/:applicationSlug`:

| Area           | Routes                                                                 |
| -------------- | ---------------------------------------------------------------------- |
| Applications   | `GET/POST /applications`, `GET/PATCH /applications/:applicationSlug`   |
| Connections    | `/connections`, `/connections/:id`, and `/connections/:id/check`       |
| Models         | `/models`, `/models/:id`, `/models/:id/cost-rules`, `/models/:id/aiu`  |
| Virtual models | `/virtual-models`, candidate routes, rules, reorder, and simulation    |
| Typed fields   | `/properties`                                                          |
| Users          | `/users`, `/users/:id`, quota, reset, and AIU journal                  |
| User groups    | `/user-groups`, preview, evaluate, members, and snapshot-based actions |
| Configuration  | `/runtime-configurations`, `/runtime-configurations/publish`           |
| Keys           | `/service-api-keys`                                                    |
| Reports        | `/reports/*`, saved reports, and dashboard cards                       |

Creating a user requires only `user_id`; `display_user`, tags, and typed properties are optional.
`user_id` cannot be changed. Blocking a user, resetting an allowance, or running a group action
requires a reason when it changes access or usage.

`PUT /models/:id/cost-rules` replaces the model's ordered fallback rule list. Each rule has a name,
`all` or `any` conditions, an optional `fixed_amount`, and zero or more `rates` containing an actual
`amount_per_unit`. Sending an empty list is valid and means reported amounts only. These rules are
consulted only when an event has no `source_cost`; they do not change `/models/:id/aiu`.

## Reports and search

Report routes are application-scoped:

- `/reports/overview`, `/reports/usage`, `/reports/provider-cost`, `/reports/aiu`;
- `/reports/cache`, `/reports/fallback`, `/reports/dimensions`, `/reports/pipeline-health`;
- `/reports/saved` and `/reports/dashboard` for reusable analyses.

Queries accept a UTC time range, timezone, match-all or match-any conditions, optional grouping,
and bounded pagination. Conditions cover built-in fields and enabled typed properties. Reports read
ClickHouse and include its watermark and lag. If ClickHouse is unavailable, the API returns an
error. It does not substitute PostgreSQL data or zero.

## Runtime

| Method and path                                    | Purpose                                                         |
| -------------------------------------------------- | --------------------------------------------------------------- |
| `GET /runtime/snapshot`                            | Read the application-bound published configuration with `ETag`. |
| `POST /runtime/configuration-acknowledgements`     | Report received, applied, or rejected status.                   |
| `POST /runtime/users/aiu/reservations`             | Check access and reserve AIU before a call.                     |
| `POST /runtime/users/aiu/reservations/:id/settle`  | Settle actual AIU after success.                                |
| `POST /runtime/users/aiu/reservations/:id/release` | Release an unused reservation.                                  |

The runtime key supplies the application identity. Reservation tokens are signed, opaque, and
validated against the persisted application, user, operation, state, and expiry.

## Health and errors

| Path                | Meaning                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `GET /health/live`  | The process is alive.                                             |
| `GET /health/ready` | PostgreSQL, Redis, ClickHouse, and required invariants are ready. |
| `GET /metrics`      | Prometheus operational metrics.                                   |

Request objects reject unknown properties unless a bounded property map is explicitly declared.
Costs, quantities, and AIU values use decimal or integer strings to preserve precision. Error
responses do not include secrets, prompt content, response content, or raw payloads. Field
definitions are in the running OpenAPI document and `packages/contracts`.

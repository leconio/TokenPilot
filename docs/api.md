# HTTP API

[中文](api.zh-CN.md)

TokenPilot exposes a strict HTTP API for usage ingestion, application administration, reports, and
trusted runtime configuration. Model traffic goes directly from the Node SDK, Python SDK, or
LiteLLM to the configured model service; TokenPilot does not implement a model-completion endpoint.

## Authentication and application binding

Server clients send `Authorization: Bearer <application-key>`. A key belongs to exactly one
application, is displayed only when created, and is stored as a hash. Its scopes should cover only
one access plane:

- ingestion: `usage:write` and Connector heartbeat;
- runtime: configuration read, acknowledgement, and AIU reservation operations;
- administration: application resources, reports, audit, and operational actions.

The API derives `application_id` from the key. A caller cannot choose or override it in an event.
All resource routes also contain `:applicationSlug`; a mismatch between the URL and key is rejected.
The Web console uses an authenticated cookie session plus CSRF protection for mutations.

## Usage ingestion

`POST /usage-events/batch` accepts a strict content-free batch. `user.user_id` is required and
`user.display_user` is recommended. A successful event automatically creates or updates that user
inside the key's application. The same `user_id` in another application is an independent user.

The event includes time, request and attempt identifiers, source and application versions, the
connection, real-model request name, optional virtual model, token and multimodal quantities,
result fields, and typed custom properties. Prompts, responses, messages, tool arguments, cookies,
authorization headers, and Provider credentials are rejected or removed before durable intake.

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
| Models         | `/models`, `/models/:id`, `/models/:id/cost`, `/models/:id/aiu`        |
| Virtual models | `/virtual-models`, candidate routes, rules, reorder, and simulation    |
| Typed fields   | `/properties`                                                          |
| Users          | `/users`, `/users/:id`, quota, reset, and AIU journal                  |
| User groups    | `/user-groups`, preview, evaluate, members, and snapshot-based actions |
| Configuration  | `/runtime-configurations`, `/runtime-configurations/publish`           |
| Keys           | `/service-api-keys`                                                    |
| Reports        | `/reports/*`, saved reports, and dashboard cards                       |

Creating a user requires only `user_id`; `display_user`, tags, and typed properties are optional.
`user_id` is immutable. Blocking a user, resetting quota, or applying a group action requires an
auditable reason where the operation is destructive or access-affecting.

## Reports and search

Report routes are application-scoped:

- `/reports/overview`, `/reports/usage`, `/reports/provider-cost`, `/reports/aiu`;
- `/reports/cache`, `/reports/fallback`, `/reports/dimensions`, `/reports/pipeline-health`;
- `/reports/saved` and `/reports/dashboard` for reusable analyses.

Queries accept a UTC time range, timezone, match-all or match-any conditions, optional grouping,
and bounded pagination. Conditions cover built-in fields and enabled typed properties. Reports read
ClickHouse only and include a watermark and lag. If analytics are unavailable, the API returns an
unavailable error instead of substituting PostgreSQL data or a fabricated zero.

## Trusted runtime

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
Exact costs, quantities, and AIU values use decimal or integer strings. Error envelopes never echo
secrets, prompt content, response content, or raw payloads. The running OpenAPI document and
`packages/contracts` are the field-level authority.

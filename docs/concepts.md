# Concepts and calculation rules

[中文](concepts.zh-CN.md)

## Usage event

The Connector sends one event per model attempt. An event has stable identifiers, model identity,
token and request lines, timing, outcome, route reason, and trusted product context. It never needs
prompt or response content. The Registry accepts an event ID once; retries return the original
result instead of creating another charge.

Common usage lines are:

- `request`: one attempted model call;
- `uncached_input_tokens`: input that was not served from a cache;
- `cache_read_tokens`: input served from a Provider cache;
- `cache_write_tokens`: input written into a Provider cache;
- `reasoning_tokens`: hidden reasoning reported by a supporting Provider;
- `output_tokens`: visible model output.

## Model

A TokenPilot model is the LiteLLM model name used for a real request, such as `openai/gpt-4.1`.
Provider cost and AI Unit rates bind directly to this model. There is no second model catalog or
runtime-model identity to maintain.

## Provider cost

Each published Provider price book defines a price per usage type and unit. The calculation uses
integer quantities and decimal arithmetic:

```text
line cost = quantity × unit price / price unit
attempt cost = sum of every matched line cost
```

All non-zero usage lines must match. If one line has no price, the whole attempt is marked unpriced.
This prevents a partial cost from looking complete. An official result can replace a provisional
result by writing a signed delta; history remains immutable.

## AI Unit

AI Unit uses a separate rate card. A simple card might define:

```text
1,000,000 input tokens    = 1.000000 AIU
1,000,000 cache-read tokens = 0.250000 AIU
1,000,000 cache-write tokens = 0.500000 AIU
1,000,000 reasoning tokens = 4.000000 AIU
1,000,000 output tokens   = 3.000000 AIU
```

The internal value is an integer number of micro-AIU. Rounding occurs once at the documented
boundary, never through floating-point arithmetic. The published rate snapshot, rounding mode, and
attempt policy are stored with the decision.

Provider cost and AI Unit are intentionally independent. A model can be priced but unrated, or
rated while Provider cost is not yet configured. Coverage pages show both gaps.

## Virtual model and routing

A virtual model is the stable model name exposed to application code. It owns all routing settings:

- one default candidate;
- an ordered fallback list;
- zero or more schedule rules;
- zero or more temporary overrides with explicit expiry;
- a monotonically increasing policy revision.

The SDK pulls the policy with an ETag and acknowledges the exact revision it applied. It keeps an
atomic last-known-good file for a bounded outage. A malformed or expired policy is never silently
accepted.

## Quota lifecycle

Measure-only mode records AI Unit without blocking. Hard-limit mode uses this lifecycle:

```text
check → reserve → call model → settle
                      └──────→ release
expired reservation ────────→ expire
```

Every transition is idempotent. The authoritative balance and journal live in PostgreSQL. ClickHouse
receives analytical projections but never decides whether a request is allowed.

## Data ownership

| Data                                            | Authority                         |
| ----------------------------------------------- | --------------------------------- |
| Model catalog, prices, rates, policies, keys    | PostgreSQL                        |
| Rating decisions, quota, reservations, journals | PostgreSQL                        |
| Queue leases and short-lived coordination       | Redis                             |
| Reports and dashboards                          | ClickHouse                        |
| Connector retry buffer                          | Local SQLite spool beside LiteLLM |

Reports do not fall back to PostgreSQL. A ClickHouse failure is visible as an unavailable report,
which is safer than returning a different or incomplete number.

TokenPilot does not proxy model traffic. LiteLLM remains in the request path while TokenPilot
receives usage events and publishes routing, pricing, and AI Unit configuration.

## Fresh database rule

The project is still under active development. PostgreSQL and ClickHouse start from the current
schema on empty volumes. Unknown or mixed schema objects are rejected; operators delete the isolated
development volumes and create the current schema again. There is no old-schema translation path.

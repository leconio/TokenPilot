# Concepts and calculation rules

[中文](concepts.zh-CN.md)

## Usage event

Every integration sends one event for each model attempt. The event contains stable IDs, model
identity, measured usage, timing, result, route reason, and allowed product fields. It does not
contain prompts or responses. Reusing an event ID returns the first result instead of recording the
attempt twice.

Common usage lines are:

- `request`: one attempted model call;
- `uncached_input_tokens`: input that was not served from a cache;
- `cache_read_tokens`: input served from a Provider cache;
- `cache_write_tokens`: input written into a Provider cache;
- `reasoning_tokens`: hidden reasoning reported by a supporting Provider;
- `output_tokens`: visible model output.

## Application, connection, real model, and virtual model

| Term          | Meaning                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------ |
| Application   | The boundary for users, fields, reports, model settings, and API keys.                     |
| Connection    | How the calling process reaches LiteLLM, an OpenAI-compatible service, or Anthropic.       |
| Real model    | A connection plus the model name sent to that service. Cost and AI Unit rules attach here. |
| Virtual model | The stable name used by application code. It selects and orders one or more real models.   |

TokenPilot stores a credential reference such as `OPENAI_API_KEY`, not the credential value. If the
same provider model is available through two connections, create two real models so their routing
and accounting stay separate.

## Provider cost

When the caller reports a cost, TokenPilot uses that amount for the attempt. This covers account
agreements, batch rates, service tiers, promotions, and other pricing that does not fit one fixed
Token price. The event also records the currency and whether the amount is estimated.

When the caller cannot report an amount, TokenPilot checks the cost rules in order. A rule can use
built-in call fields or typed event and user properties. The first match adds an optional fixed
amount to the configured usage amounts:

```text
rule cost = fixed amount + sum(quantity × amount per unit)
```

If there is no reported amount and no rule matches, the attempt is unpriced. The rule list can stay
empty when callers always report cost. Reported cost keeps its own currency; a rule uses the
application currency. A later official result writes a signed adjustment instead of changing the
earlier record.

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

Provider cost and AI Unit are separate. Changing cost reporting or a cost rule does not change AI
Unit conversion, allowance, reservation, or enforcement. The console shows missing cost and missing
AI Unit rules separately.

## Virtual model and routing

A virtual model is the stable model name exposed to application code. It owns all routing settings:

- one default candidate;
- an ordered fallback list;
- zero or more schedule rules;
- zero or more temporary overrides with explicit expiry;
- a monotonically increasing policy revision.

The SDK uses an ETag when it checks for policy updates and reports the revision it applied. It keeps
the last valid policy in a local file for short outages. It rejects malformed or expired policies.

## Quota lifecycle

Measure-only mode records AI Unit without blocking. Hard-limit mode uses this lifecycle:

```text
check → reserve → call model → settle
                      └──────→ release
expired reservation ────────→ expire
```

Every transition is idempotent. The balance and journal used for access decisions live in
PostgreSQL. ClickHouse receives analytical projections but does not decide whether a request is
allowed.

## Data ownership

| Data                                             | Stored in                            |
| ------------------------------------------------ | ------------------------------------ |
| Model catalog, cost rules, rates, policies, keys | PostgreSQL                           |
| Rating decisions, quota, reservations, journals  | PostgreSQL                           |
| Queue leases and short-lived coordination        | Redis                                |
| Reports and dashboards                           | ClickHouse                           |
| SDK or Connector retry buffer                    | Local SQLite spool beside the caller |

Reports do not fall back to PostgreSQL. When ClickHouse is unavailable, the report returns an error
instead of a number from a different data source.

TokenPilot does not proxy model traffic. The Node/Python SDK can call a registered connection
directly, while the LiteLLM Connector keeps LiteLLM in the request path. Both send the same event
contract and receive the same published routing policy.

## Fresh database rule

The project is still under active development. PostgreSQL and ClickHouse start from the current
schema on empty volumes. Unknown or mixed schema objects are rejected; operators delete the isolated
development volumes and create the current schema again. There is no old-schema translation path.

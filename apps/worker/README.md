# Worker application

The Worker application runs the Control Plane's BullMQ consumers. PostgreSQL owns configuration,
Provider Cost, AIU, quota, and durable pipeline authority. ClickHouse receives projections through
the transactional Outbox and owns the report query path. PostgreSQL, Redis, and ClickHouse are all
required for Worker readiness.

The usage pipeline validates the canonical event contract, verifies trusted
usage context, resolves the reported model, rates model cost and AIU,
settles quota, commits authority records atomically, and then projects Outbox
records to ClickHouse. The `usage_pipeline` feature flag controls this path.

Operational consumers handle reports, exports, current-state maintenance, and reconciliation.
Usage-export rows and counts plus the unpriced Provider Cost alert read only the canonical
`current_usage_events_raw` and `current_rating_events` ClickHouse views; they never fall back to
PostgreSQL. Both operations cover every event stored by this control plane, regardless of the
reporting gateway's `source.instance_id`; the Worker `INSTANCE_ID` never filters reported usage.
Failed jobs retain bounded diagnostic
metadata for retry and dead-letter inspection without exposing raw payloads.

Run the package checks without a local container runtime:

```bash
pnpm --filter @tokenpilot/worker typecheck
pnpm --filter @tokenpilot/worker test:integration
pnpm --filter @tokenpilot/worker build
```

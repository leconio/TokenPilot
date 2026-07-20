# Scheduler application

The scheduler reconciles deterministic BullMQ jobs every minute. It creates hourly and daily report
aggregations, minute-level connector/override checks, hourly unpriced alerts, and daily raw-event
retention/API-key expiry jobs. Deterministic UTC bucket IDs make restart and overlapping scheduler
instances safe; workers keep the authoritative result in `background_jobs`.

```bash
pnpm --filter @tokenpilot/scheduler dev
pnpm --filter @tokenpilot/scheduler test
```

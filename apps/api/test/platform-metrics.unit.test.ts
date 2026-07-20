import { describe, expect, it } from "vitest";

import { createOpenMetricsRegistry } from "../src/metrics-registry.js";
import { ApiPlatformMetrics } from "../src/platform-metrics.js";

const state = {
  inbox_pending: 3,
  inbox_oldest_age: 61,
  outbox_backlog: 4,
  sink_lag: 31,
  raw_watermark: 100,
  official_watermark: 90,
  reservations_active: 5,
  negative_balance_users: 1,
  reconciliation_last_success: 80,
};

describe("API platform metrics", () => {
  it("publishes ingestion and persisted operational state without entity labels", async () => {
    const registry = createOpenMetricsRegistry();
    const metrics = new ApiPlatformMetrics(registry, {
      $queryRaw: () => Promise.resolve([state]),
    });
    metrics.recordIngestion({
      accepted: 10,
      duplicates: 2,
      rejected: 1,
      payloadConflicts: 1,
      latencySeconds: 0.2,
    });
    metrics.recordQuota("deny");
    await metrics.refresh(new Date("2026-07-16T00:00:00.000Z"));

    const output = await registry.metrics();
    expect(output).toContain("ai_control_ingestion_events_total 13");
    expect(output).toContain("ai_control_ingestion_batches_total 1");
    expect(output).toContain("ai_control_ingestion_payload_conflicts_total 1");
    expect(output).toContain("ai_control_inbox_pending_total 3");
    expect(output).toContain("ai_control_inbox_oldest_age_seconds 61");
    expect(output).toContain("ai_control_clickhouse_outbox_backlog 4");
    expect(output).toContain('ai_control_quota_check_total{decision="deny"} 1');
    expect(output).toContain("ai_control_quota_negative_balance_users 1");
    expect(output).not.toMatch(/(?:subject|request|event|attempt|operation)_id=/u);
  });

  it("fails a scrape when PostgreSQL returns no state row", async () => {
    const metrics = new ApiPlatformMetrics(createOpenMetricsRegistry(), {
      $queryRaw: () => Promise.resolve([]),
    });
    await expect(metrics.refresh()).rejects.toThrow(/no operational metric state/u);
  });
});

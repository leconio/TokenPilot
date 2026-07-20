import { type AddressInfo } from "node:net";

import { Registry } from "prom-client";
import { afterEach, describe, expect, it } from "vitest";

import {
  closeMetricsServer,
  observedQueueNames,
  operationalErrorCode,
  serializeOperationalLog,
  startWorkerMetricsServer,
  WorkerObservability,
  type QueueMetricsRedis,
} from "../src/observability.js";

class MemoryMetricsRedis implements QueueMetricsRedis {
  llen(key: string): Promise<number> {
    return Promise.resolve(key.endsWith(":wait") ? 2 : key.endsWith(":active") ? 1 : 0);
  }

  zcard(key: string): Promise<number> {
    return Promise.resolve(key.endsWith(":failed") ? 3 : 0);
  }
}

class OfflineMetricsRedis implements QueueMetricsRedis {
  llen(): Promise<number> {
    return Promise.reject(new Error("REDIS_SECRET_SENTINEL"));
  }

  zcard(): Promise<number> {
    return Promise.reject(new Error("REDIS_SECRET_SENTINEL"));
  }
}

const servers: Array<Awaited<ReturnType<typeof startWorkerMetricsServer>>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeMetricsServer(server)));
});

describe("Worker observability", () => {
  it("uses the unified correlation schema without serializing exception messages", () => {
    const line = serializeOperationalLog(
      {
        level: "error",
        component: "worker",
        event: "usage.pricing.failed",
        requestId: "request-1",
        eventId: "event-1",
        jobId: "job-1",
        traceId: "0123456789abcdef0123456789abcdef",
        errorCode: operationalErrorCode(new Error("PROMPT_SENTINEL")),
        durationMs: 12.5,
      },
      new Date("2026-07-15T12:00:00.000Z"),
    );
    expect(JSON.parse(line)).toEqual({
      timestamp: "2026-07-15T12:00:00.000Z",
      level: "error",
      component: "worker",
      event: "usage.pricing.failed",
      request_id: "request-1",
      event_id: "event-1",
      job_id: "job-1",
      trace_id: "0123456789abcdef0123456789abcdef",
      operation_id: null,
      attempt_id: null,
      rating_id: null,
      transaction_id: null,
      error_code: "Error",
      duration_ms: 12.5,
    });
    expect(line).not.toContain("PROMPT_SENTINEL");
  });

  it("redacts credentials, request content, and raw subjects from structured attributes", () => {
    const line = serializeOperationalLog({
      level: "info",
      component: "worker",
      event: "settlement.completed",
      attributes: {
        subject_id: "raw-subject",
        subject_hash: "sha256:pseudonym",
        prompt: "private prompt",
        provider_api_key: "private key",
      },
    });
    expect(line).not.toContain("raw-subject");
    expect(line).not.toContain("private prompt");
    expect(line).not.toContain("private key");
    expect(line).toContain("sha256:pseudonym");
  });

  it("publishes settlement, ClickHouse, AIU, quota, reservation, and reconciliation metrics", async () => {
    const metrics = new WorkerObservability(new MemoryMetricsRedis());
    metrics.platform.recordSettlement({
      stage: "provider_cost",
      status: "dead_letter",
      latencySeconds: 0.2,
    });
    metrics.platform.recordRating({
      providerCostUnpriced: true,
      aiuUnrated: true,
      modelUnmapped: true,
      ratedAiuMicros: 25,
      consumedAiuMicros: 20,
      adjustedAiuMicros: 5,
    });
    metrics.platform.recordClickHouse({
      operation: "insert",
      success: false,
      latencySeconds: 0.1,
      rows: 2,
      bytes: 64,
    });
    metrics.platform.setClickHouseState({
      healthy: false,
      outboxBacklog: 7,
      sinkLagSeconds: 45,
      rawWatermarkSeconds: 100,
      officialWatermarkSeconds: 90,
      storageUtilizationRatio: 0.86,
    });
    metrics.platform.recordQuota("deny");
    metrics.platform.setQuotaState(3, 1);
    metrics.platform.recordExpiredReservations(2);
    metrics.platform.recordReconciliation({
      runType: "hourly",
      status: "completed",
      diffs: [{ type: "CH_MISSING", severity: "critical", count: 2 }],
      costDelta: -1.25,
      aiuMicroDelta: -40,
      finishedAt: new Date("2026-07-16T00:00:00.000Z"),
    });

    const output = await metrics.render();
    for (const name of [
      "ai_control_settlement_events_total",
      "ai_control_provider_cost_unpriced_total",
      "ai_control_aiu_unrated_total",
      "ai_control_model_unmapped_total",
      "ai_control_clickhouse_insert_failures_total",
      "ai_control_clickhouse_outbox_backlog",
      "ai_control_quota_check_total",
      "ai_control_quota_reservation_expired_total",
      "ai_control_reconciliation_runs_total",
      "ai_control_reconciliation_diff_total",
    ]) {
      expect(output).toContain(name);
    }
    expect(output).not.toMatch(/(?:subject|request|event|attempt|operation)_id=/u);
  });

  it("publishes fixed-stage counters and fixed-queue depth gauges", async () => {
    const metrics = new WorkerObservability(new MemoryMetricsRedis());
    metrics.recordFailure("operational");
    metrics.observeJob("operational", "completed", 250);

    const output = await metrics.render();
    expect(metrics.contentType()).toBe(Registry.OPENMETRICS_CONTENT_TYPE);
    expect(output).toMatch(/# EOF\n$/u);
    expect(output).toContain('ai_control_usage_processing_failures_total{stage="operational"} 1');
    for (const queue of observedQueueNames) {
      expect(output).toContain(`ai_control_queue_depth{queue="${queue}"} 3`);
      expect(output).toContain(`ai_control_queue_failed_depth{queue="${queue}"} 3`);
    }
  });

  it("publishes low-cardinality database latency without query contents", async () => {
    const metrics = new WorkerObservability(new MemoryMetricsRedis());
    metrics.observeDatabaseQuery({
      model: "UsageEventRaw",
      operation: "update",
      outcome: "success",
      durationSeconds: 0.012,
    });

    const output = await metrics.render();
    expect(output).toContain(
      'ai_control_db_query_duration_seconds_count{component="worker",model="UsageEventRaw",operation="update",outcome="success"} 1',
    );
    expect(output).not.toContain("SELECT");
    expect(output).not.toContain("PARAM_SENTINEL");
  });

  it("serves metrics plus liveness and dependency-aware readiness routes", async () => {
    const metrics = new WorkerObservability(new MemoryMetricsRedis());
    const server = await startWorkerMetricsServer(metrics, {
      host: "127.0.0.1",
      port: 0,
      readiness: () =>
        Promise.resolve({
          ready: true,
          checks: { runtime: true, postgres: true, clickhouse: true, redis: true },
        }),
    });
    servers.push(server);
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(Registry.OPENMETRICS_CONTENT_TYPE);
    const body = await response.text();
    expect(body).toContain("ai_control_queue_depth");
    expect(body).toMatch(/# EOF\n$/u);

    const live = await fetch(`http://127.0.0.1:${address.port}/health/live`);
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toEqual({ status: "ok" });

    const ready = await fetch(`http://127.0.0.1:${address.port}/health/ready`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({
      ready: true,
      checks: { runtime: true, postgres: true, clickhouse: true, redis: true },
    });

    const missing = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(missing.status).toBe(404);
  });

  it("keeps readiness closed when no dependency probe is configured", async () => {
    const metrics = new WorkerObservability(new MemoryMetricsRedis());
    const server = await startWorkerMetricsServer(metrics, { host: "127.0.0.1", port: 0 });
    servers.push(server);
    const address = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/health/ready`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ready: false });
  });

  it("keeps process counters scrapeable when queue collection is unavailable", async () => {
    const metrics = new WorkerObservability(new OfflineMetricsRedis());
    metrics.recordFailure("operational");
    const output = await metrics.render();
    expect(output).toContain('ai_control_usage_processing_failures_total{stage="operational"} 1');
    expect(output).toContain("ai_control_worker_metrics_collection_failures_total 1");
    expect(output).not.toContain("REDIS_SECRET_SENTINEL");
  });
});

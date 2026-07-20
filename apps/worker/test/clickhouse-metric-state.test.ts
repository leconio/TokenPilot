import { describe, expect, it, vi } from "vitest";

import type { ClickHouseOperations } from "@tokenpilot/clickhouse";
import type { DatabaseClient } from "@tokenpilot/db";

import { ClickHouseMetricStateReader } from "../src/clickhouse-metric-state.js";

function database() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([
      {
        outbox_backlog: 7,
        sink_lag_seconds: 45,
        raw_watermark_seconds: 100,
        official_watermark_seconds: 90,
        sync_healthy: true,
      },
    ]),
  } as unknown as DatabaseClient;
}

function clickhouse() {
  return {
    queryRows: vi.fn(async (request: { readonly name: string }) =>
      request.name === "runtime_storage.read"
        ? { queryId: "storage-query", rows: [{ storage_utilization_ratio: 0.75 }] }
        : { queryId: "health-query", rows: [{ healthy: 1 }] },
    ),
  } as unknown as ClickHouseOperations;
}

describe("ClickHouse metric state", () => {
  it("combines authoritative PG lag/watermarks with a live ClickHouse query", async () => {
    const db = database();
    const ch = clickhouse();

    await expect(
      new ClickHouseMetricStateReader(db, ch).read(new Date("2026-07-16T12:00:00.000Z")),
    ).resolves.toEqual({
      healthy: true,
      outboxBacklog: 7,
      sinkLagSeconds: 45,
      rawWatermarkSeconds: 100,
      officialWatermarkSeconds: 90,
      storageUtilizationRatio: 0.75,
    });
    expect(ch.queryRows).toHaveBeenCalledWith({
      name: "runtime_health.read",
      query: "SELECT 1 AS healthy",
    });
    expect(ch.queryRows).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "runtime_storage.read",
        query: expect.stringContaining("FROM system.disks"),
      }),
    );
  });

  it("marks state unhealthy without hiding durable lag when ClickHouse is unavailable", async () => {
    const db = database();
    const ch = clickhouse();
    vi.mocked(ch.queryRows).mockImplementation(async (request) => {
      if (request.name === "runtime_health.read") throw new Error("clickhouse unavailable");
      return { queryId: "storage-query", rows: [{ storage_utilization_ratio: 0.75 }] } as never;
    });

    await expect(new ClickHouseMetricStateReader(db, ch).read()).resolves.toMatchObject({
      healthy: false,
      outboxBacklog: 7,
      sinkLagSeconds: 45,
    });
  });

  it("keeps health and lag available when disk metadata collection fails", async () => {
    const db = database();
    const ch = clickhouse();
    vi.mocked(ch.queryRows).mockImplementation(async (request) => {
      if (request.name === "runtime_storage.read") throw new Error("system.disks unavailable");
      return { queryId: "health-query", rows: [{ healthy: 1 }] } as never;
    });

    const state = await new ClickHouseMetricStateReader(db, ch).read();

    expect(state).toMatchObject({ healthy: true, outboxBacklog: 7, sinkLagSeconds: 45 });
    expect(state).not.toHaveProperty("storageUtilizationRatio");
  });
});

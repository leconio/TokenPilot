import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { ClickHouseClient } from "@tokenpilot/clickhouse";
import type { DatabaseClient } from "@tokenpilot/db";

import { HealthService } from "../src/health.controller.js";

function clickHouse(healthy = true): ClickHouseClient {
  return {
    query: vi.fn().mockImplementation(async () => {
      if (!healthy) throw new Error("connection refused with a secret that must not escape");
      return {
        json: vi.fn().mockResolvedValue([{ version: "26.6.1", database: "ai_control_plane" }]),
      };
    }),
  } as unknown as ClickHouseClient;
}

function database(healthy = true): DatabaseClient {
  return {
    $queryRaw: healthy
      ? vi.fn().mockResolvedValue([{ ready: 1 }])
      : vi.fn().mockRejectedValue(new Error("postgres unavailable")),
  } as unknown as DatabaseClient;
}

function redis(healthy = true) {
  return {
    ping: vi.fn().mockResolvedValue(healthy ? "PONG" : "NOT_PONG"),
  };
}

describe("API required datastore readiness", () => {
  it("is ready only after PostgreSQL, Redis, and ClickHouse all respond", async () => {
    const service = new HealthService(database(), redis() as never, clickHouse());

    await expect(service.readiness()).resolves.toEqual({
      status: "ready",
      dependencies: { postgres: "healthy", redis: "healthy", clickhouse: "healthy" },
    });
  });

  it.each([
    ["postgres", database(false), redis(), clickHouse()],
    ["redis", database(), redis(false), clickHouse()],
    ["clickhouse", database(), redis(), clickHouse(false)],
  ] as const)("fails closed when %s is unavailable", async (_name, postgres, cache, analytics) => {
    const service = new HealthService(postgres, cache as never, analytics);

    await expect(service.assertReady()).rejects.toBeInstanceOf(ServiceUnavailableException);
    const checks = await service.dependencyChecks();
    expect(checks[_name]).toBe("unavailable");
  });

  it("bounds health checks that never settle", async () => {
    vi.useFakeTimers();
    const pending = new Promise<never>(() => undefined);
    const service = new HealthService(
      { $queryRaw: vi.fn().mockReturnValue(pending) } as unknown as DatabaseClient,
      { ping: vi.fn().mockReturnValue(pending) } as never,
      { query: vi.fn().mockReturnValue(pending) } as unknown as ClickHouseClient,
    );
    const result = service.dependencyChecks();

    await vi.advanceTimersByTimeAsync(3_000);
    await expect(result).resolves.toEqual({
      postgres: "unavailable",
      redis: "unavailable",
      clickhouse: "unavailable",
    });
    vi.useRealTimers();
  });
});

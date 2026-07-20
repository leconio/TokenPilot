import { describe, expect, it, vi } from "vitest";

import { createWorkerReadinessProbe } from "../src/readiness.js";

type ReadinessInput = Parameters<typeof createWorkerReadinessProbe>[0];

function inputWith(
  databaseResult: Promise<Array<{ ready: number }>>,
  clickhouseResult: Promise<boolean>,
  redisResult: Promise<string>,
  runtime = true,
): ReadinessInput {
  return {
    database: {
      $queryRaw: vi.fn().mockReturnValue(databaseResult),
    } as unknown as ReadinessInput["database"],
    redis: {
      ping: vi.fn().mockReturnValue(redisResult),
    } as unknown as ReadinessInput["redis"],
    checkClickHouse: vi.fn().mockReturnValue(clickhouseResult),
    isStarted: () => runtime,
  };
}

describe("Worker readiness", () => {
  it("reports ready only after runtime, PostgreSQL, and ClickHouse are available", async () => {
    const probe = createWorkerReadinessProbe(
      inputWith(Promise.resolve([{ ready: 1 }]), Promise.resolve(true), Promise.resolve("PONG")),
    );

    await expect(probe()).resolves.toEqual({
      ready: true,
      checks: { runtime: true, postgres: true, clickhouse: true, redis: true },
    });
  });

  it("fails closed with boolean checks and never exposes dependency errors", async () => {
    const probe = createWorkerReadinessProbe(
      inputWith(
        Promise.reject(new Error("POSTGRES_SECRET_SENTINEL")),
        Promise.reject(new Error("CLICKHOUSE_SECRET_SENTINEL")),
        Promise.resolve("REDIS_SECRET_SENTINEL"),
      ),
    );

    const result = await probe();
    expect(result).toEqual({
      ready: false,
      checks: { runtime: true, postgres: false, clickhouse: false, redis: false },
    });
    expect(JSON.stringify(result)).not.toMatch(/SECRET_SENTINEL/u);
  });

  it("fails closed when ClickHouse is unavailable even if PostgreSQL is healthy", async () => {
    const probe = createWorkerReadinessProbe(
      inputWith(Promise.resolve([{ ready: 1 }]), Promise.resolve(false), Promise.resolve("PONG")),
    );

    await expect(probe()).resolves.toMatchObject({
      ready: false,
      checks: { postgres: true, clickhouse: false },
    });
  });
});

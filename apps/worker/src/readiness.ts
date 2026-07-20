import type { Redis } from "ioredis";

import { Prisma, type DatabaseClient } from "@tokenpilot/db";

export interface WorkerReadinessResult {
  readonly ready: boolean;
  readonly checks: {
    readonly runtime: boolean;
    readonly postgres: boolean;
    readonly clickhouse: boolean;
    readonly redis: boolean;
  };
}

export function createWorkerReadinessProbe(input: {
  readonly database: DatabaseClient;
  readonly redis: Pick<Redis, "ping">;
  readonly checkClickHouse: () => Promise<boolean>;
  readonly isStarted: () => boolean;
}): () => Promise<WorkerReadinessResult> {
  return async () => {
    const [postgresResult, clickhouseResult, redisResult] = await Promise.allSettled([
      input.database.$queryRaw<Array<{ ready: number }>>(Prisma.sql`SELECT 1 AS ready`),
      input.checkClickHouse(),
      input.redis.ping(),
    ]);
    const runtime = input.isStarted();
    const postgres = postgresResult.status === "fulfilled" && postgresResult.value[0]?.ready === 1;
    const clickhouse = clickhouseResult.status === "fulfilled" && clickhouseResult.value;
    const redis = redisResult.status === "fulfilled" && redisResult.value === "PONG";
    return {
      ready: runtime && postgres && clickhouse && redis,
      checks: { runtime, postgres, clickhouse, redis },
    };
  };
}

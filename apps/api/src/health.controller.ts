import { Controller, Get, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { Redis } from "ioredis";

import { checkClickHouseHealth, type ClickHouseClient } from "@tokenpilot/clickhouse";
import { Prisma, type DatabaseClient } from "@tokenpilot/db";

import { CLICKHOUSE_CLIENT, DATABASE_CLIENT, REDIS_CLIENT } from "./tokens.js";

const dependencyCheckTimeoutMs = 3_000;

function boundedDependencyCheck<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Required dependency health check timed out")),
      dependencyCheckTimeoutMs,
    );
    operation.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export type RequiredDependencyState = "healthy" | "unavailable";

export interface RequiredDependencyChecks {
  readonly postgres: RequiredDependencyState;
  readonly redis: RequiredDependencyState;
  readonly clickhouse: RequiredDependencyState;
}

export interface HealthyRequiredDependencies {
  readonly postgres: "healthy";
  readonly redis: "healthy";
  readonly clickhouse: "healthy";
}

export interface ReadinessResult {
  readonly status: "ready";
  readonly dependencies: HealthyRequiredDependencies;
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(CLICKHOUSE_CLIENT) private readonly clickhouse: ClickHouseClient,
  ) {}

  async dependencyChecks(): Promise<RequiredDependencyChecks> {
    const [postgres, redis, clickhouse] = await Promise.allSettled([
      boundedDependencyCheck(
        this.database.$queryRaw<Array<{ readonly ready: number }>>(Prisma.sql`SELECT 1 AS ready`),
      ),
      boundedDependencyCheck(this.redis.ping()),
      boundedDependencyCheck(checkClickHouseHealth(this.clickhouse)),
    ]);
    return {
      postgres:
        postgres.status === "fulfilled" && postgres.value[0]?.ready === 1
          ? "healthy"
          : "unavailable",
      redis: redis.status === "fulfilled" && redis.value === "PONG" ? "healthy" : "unavailable",
      clickhouse:
        clickhouse.status === "fulfilled" && clickhouse.value.ok ? "healthy" : "unavailable",
    };
  }

  async assertReady(): Promise<HealthyRequiredDependencies> {
    const dependencies = await this.dependencyChecks();
    if (
      dependencies.postgres !== "healthy" ||
      dependencies.redis !== "healthy" ||
      dependencies.clickhouse !== "healthy"
    ) {
      throw new ServiceUnavailableException("A required dependency is unavailable");
    }
    return { postgres: "healthy", redis: "healthy", clickhouse: "healthy" };
  }

  async readiness(): Promise<ReadinessResult> {
    return { status: "ready", dependencies: await this.assertReady() };
  }
}

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("live")
  liveness(): { readonly status: "live" } {
    return { status: "live" };
  }

  @Get("ready")
  readiness() {
    return this.health.readiness();
  }
}

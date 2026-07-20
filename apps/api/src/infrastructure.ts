import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

import {
  createClickHouseClient,
  loadClickHouseConfig,
  type ClickHouseClient,
} from "@tokenpilot/clickhouse";
import { createPrismaClient, type DatabaseClient } from "@tokenpilot/db";
import {
  EXPORTS_GENERATE_QUEUE,
  MAINTENANCE_QUEUE,
  RECONCILIATION_QUEUE,
  type EXPORTS_GENERATE_JOB,
  type MAINTENANCE_JOB,
  type OperationalJobData,
  type ReconciliationJobData,
} from "@tokenpilot/shared";

import type { ApiConfiguration } from "./api-config.js";
import {
  DATABASE_CLIENT,
  EXPORT_QUEUE,
  MAINTENANCE_QUEUE as MAINTENANCE_QUEUE_TOKEN,
  CLICKHOUSE_CLIENT,
  RECONCILIATION_QUEUE as RECONCILIATION_QUEUE_TOKEN,
  REDIS_CLIENT,
} from "./tokens.js";
export type ExportQueue = Queue<OperationalJobData, unknown, typeof EXPORTS_GENERATE_JOB>;
export type MaintenanceQueue = Queue<OperationalJobData, unknown, typeof MAINTENANCE_JOB>;
export type ReconciliationQueue = Queue<ReconciliationJobData>;

export interface ApiInfrastructure {
  readonly database: DatabaseClient;
  readonly redis: Redis;
  readonly exportQueue: ExportQueue;
  readonly maintenanceQueue: MaintenanceQueue;
  readonly reconciliationQueue: ReconciliationQueue;
  readonly clickhouse: ClickHouseClient;
}

export function createApiInfrastructure(configuration: ApiConfiguration): ApiInfrastructure {
  const clickHouseConfiguration = loadClickHouseConfig(process.env);
  const redis = new Redis(configuration.redisUrl, {
    enableReadyCheck: true,
    maxRetriesPerRequest: null,
  });
  const exportQueue = new Queue<OperationalJobData, unknown, typeof EXPORTS_GENERATE_JOB>(
    EXPORTS_GENERATE_QUEUE,
    {
      connection: redis,
      defaultJobOptions: {
        attempts: 8,
        backoff: { type: "exponential", delay: 1000, jitter: 0.5 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    },
  );
  const maintenanceQueue = new Queue<OperationalJobData, unknown, typeof MAINTENANCE_JOB>(
    MAINTENANCE_QUEUE,
    {
      connection: redis,
      defaultJobOptions: {
        attempts: 8,
        backoff: { type: "exponential", delay: 1000, jitter: 0.5 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    },
  );
  const reconciliationQueue = new Queue<ReconciliationJobData>(RECONCILIATION_QUEUE, {
    connection: redis,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000, jitter: 0.5 },
      removeOnComplete: 100,
      removeOnFail: 1_000,
    },
  });
  return {
    database: createPrismaClient(configuration.databaseUrl),
    redis,
    exportQueue,
    maintenanceQueue,
    reconciliationQueue,
    clickhouse: createClickHouseClient(clickHouseConfiguration),
  };
}

@Injectable()
export class InfrastructureShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(EXPORT_QUEUE) private readonly exportQueue: ExportQueue,
    @Inject(MAINTENANCE_QUEUE_TOKEN) private readonly maintenanceQueue: MaintenanceQueue,
    @Inject(RECONCILIATION_QUEUE_TOKEN)
    private readonly reconciliationQueue: ReconciliationQueue,
    @Inject(CLICKHOUSE_CLIENT) private readonly clickhouse: ClickHouseClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.exportQueue.close();
    await this.maintenanceQueue.close();
    await this.reconciliationQueue.close();
    await this.clickhouse.close();
    await this.redis.quit();
    await this.database.$disconnect();
  }
}

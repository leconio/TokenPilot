import type { ConnectionOptions, Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";

import {
  ClickHouseOperations,
  ClickHouseOutboxBatchSink,
  checkClickHouseHealth,
  type ClickHouseClient,
  type ClickHouseMetricsSink,
  type ClickHouseRuntimeConfig,
} from "@tokenpilot/clickhouse";
import type { DatabaseClient } from "@tokenpilot/db";
import type { ReconciliationTolerance } from "@tokenpilot/reconciliation-engine";
import {
  type InstanceFeatureFlags,
  type ReconciliationJobData,
  type WorkerEnvironment,
} from "@tokenpilot/shared";

import {
  ClickHouseOutboxProcessor,
  InboxPayloadCleanupService,
  PrismaClickHouseOutboxStore,
  PrismaInboxPipelineStore,
  UsagePipelineProcessor,
} from "./pipeline/index.js";
import {
  ApplicationUsageOfficialWriter,
  ApplicationUsageStageHandlers,
} from "./application-usage/index.js";
import type { WorkerPlatformMetrics } from "./platform-metrics.js";
import {
  configureReconciliationSchedules,
  createReconciliationQueue,
  createReconciliationWorker,
  PrismaReconciliationRepository,
  ReconciliationRunner,
} from "./reconciliation/index.js";
import { DualStoreReconciliationSnapshotSource } from "./reconciliation/index.js";
import {
  ClickHouseScriptRebuildExecutor,
  PrismaReconciliationOperationExecutor,
} from "./reconciliation/index.js";
import { ClickHouseMetricStateReader } from "./clickhouse-metric-state.js";
import { CurrentMaintenanceService, createCurrentMaintenancePollers } from "./maintenance/index.js";
import { SerialPoller } from "./serial-poller.js";
import {
  reconciliationRunType,
  recordClickHouseOutboxOutcome,
  recordPipelineOutcomes,
  recordReconciliationCompletion,
} from "./runtime-metric-recording.js";
import { UserGroupRefresher } from "./user-groups/index.js";

type DataPlaneEnvironment = WorkerEnvironment;

export interface DataPlaneRuntimeLogger {
  info(event: string, attributes?: Readonly<Record<string, unknown>>): void;
  error(event: string, error: unknown, attributes?: Readonly<Record<string, unknown>>): void;
}

export interface DataPlaneRuntimeOptions {
  readonly database: DatabaseClient;
  readonly redis: Redis;
  readonly clickhouse: ClickHouseClient;
  readonly clickhouseConfig: ClickHouseRuntimeConfig;
  readonly environment: DataPlaneEnvironment;
  readonly flags: InstanceFeatureFlags;
  readonly metrics: WorkerPlatformMetrics;
  readonly logger: DataPlaneRuntimeLogger;
}

function clickHouseMetrics(platform: WorkerPlatformMetrics): ClickHouseMetricsSink {
  return {
    record(metric) {
      platform.recordClickHouse({
        operation: metric.operation,
        success: metric.outcome === "success",
        latencySeconds: metric.durationMs / 1_000,
        rows: metric.rows,
        bytes: metric.bytes,
      });
    },
  };
}

function reconciliationTolerance(environment: DataPlaneEnvironment): ReconciliationTolerance {
  return {
    providerCost: environment.RECON_COST_TOLERANCE,
    aiuMicros: environment.RECON_AIU_MICRO_TOLERANCE.toString(),
    watermarkStallSeconds: 600,
  };
}

export class DataPlaneRuntime {
  private readonly pollers: readonly SerialPoller[];
  private started = false;

  constructor(
    pollers: readonly SerialPoller[],
    private readonly clickhouse: ClickHouseClient,
    private readonly reconciliationQueue: Queue<ReconciliationJobData> | null,
    private readonly reconciliationWorker: Worker<ReconciliationJobData> | null,
    private readonly schedules: { readonly hourly: boolean; readonly daily: boolean } | null,
  ) {
    this.pollers = pollers;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!(await this.isClickHouseReady())) {
      throw new TypeError("ClickHouse is required but unavailable");
    }
    if (this.reconciliationQueue !== null && this.schedules !== null) {
      await configureReconciliationSchedules(this.reconciliationQueue, this.schedules);
      await Promise.all([
        this.reconciliationQueue.waitUntilReady(),
        this.reconciliationWorker!.waitUntilReady(),
      ]);
    }
    for (const poller of this.pollers) poller.start();
    this.started = true;
  }

  async close(): Promise<void> {
    await Promise.all(this.pollers.map((poller) => poller.close()));
    await this.reconciliationWorker?.close();
    await this.reconciliationQueue?.close();
    await this.clickhouse.close();
    this.started = false;
  }

  async isClickHouseReady(): Promise<boolean> {
    return (await checkClickHouseHealth(this.clickhouse)).ok;
  }
}

export function createDataPlaneRuntime(options: DataPlaneRuntimeOptions): DataPlaneRuntime {
  const { database, environment, flags, logger, metrics } = options;
  const pollers: SerialPoller[] = [];
  const currentMaintenance = new CurrentMaintenanceService(
    database,
    new InboxPayloadCleanupService(database),
    metrics,
    logger,
  );
  pollers.push(
    ...createCurrentMaintenancePollers(
      currentMaintenance,
      flags.quota,
      {
        inboxPayloadCleanupIntervalMs: environment.INBOX_PAYLOAD_CLEANUP_INTERVAL_MS,
        inboxPayloadCleanupBatchSize: environment.INBOX_PAYLOAD_CLEANUP_BATCH_SIZE,
        reservationSweepIntervalMs: environment.AIU_RESERVATION_SWEEP_INTERVAL_MS,
        reservationSweepBatchSize: environment.AIU_RESERVATION_SWEEP_BATCH_SIZE,
      },
      logger,
    ),
  );
  const userGroups = new UserGroupRefresher(database, options.clickhouse, options.redis, logger);
  pollers.push(
    new SerialPoller({
      name: "user-group-refresh",
      intervalMs: 60_000,
      async run() {
        await userGroups.refreshDue(50);
      },
      onError(error) {
        logger.error("user_group.refresh.poller.failed", error);
      },
    }),
  );
  const usageEnabled = flags.usage_pipeline;
  if (usageEnabled) {
    const handlers = new ApplicationUsageStageHandlers(database);
    const writer = new ApplicationUsageOfficialWriter();
    const processor = new UsagePipelineProcessor(
      new PrismaInboxPipelineStore(database, {
        payloadTtlDays: environment.INBOX_PAYLOAD_RETENTION_DAYS,
      }),
      handlers,
      writer,
      {
        usagePipeline: true,
        modelResolution: flags.model_catalog,
        providerCost: true,
        aiu: flags.aiu,
        quota: flags.quota,
      },
    );
    const usagePipelinePoller = new SerialPoller({
      name: "usage-pipeline",
      intervalMs: environment.PIPELINE_POLL_INTERVAL_MS,
      async run() {
        const outcomes = await processor.runBatch();
        if (outcomes.length === 0) return;
        recordPipelineOutcomes(metrics, outcomes);
        logger.info("usage.pipeline.batch.completed", {
          leased: outcomes.length,
          completed: outcomes.filter((outcome) => outcome.status === "completed").length,
          retried: outcomes.filter((outcome) => outcome.status === "retry_scheduled").length,
          failed: outcomes.filter((outcome) => outcome.status === "failed").length,
          dead_lettered: outcomes.filter((outcome) => outcome.status === "dead_lettered").length,
        });
      },
      onError(error) {
        logger.error("usage.pipeline.batch.failed", error);
      },
    });
    pollers.push(usagePipelinePoller);
  }

  const operations = new ClickHouseOperations(
    options.clickhouse,
    options.clickhouseConfig,
    clickHouseMetrics(metrics),
  );
  const metricState = new ClickHouseMetricStateReader(database, operations);
  const sink = new ClickHouseOutboxBatchSink(operations, {
    environment: environment.ENVIRONMENT,
    instanceId: environment.INSTANCE_ID,
    pipelineName: "dual_store",
  });
  const processor = new ClickHouseOutboxProcessor(
    new PrismaClickHouseOutboxStore(database, { pipelineName: "dual_store" }),
    sink,
    { maxAttempts: environment.CH_SINK_MAX_RETRIES },
  );
  const clickHouseOutboxPoller = new SerialPoller({
    name: "clickhouse-outbox",
    intervalMs: environment.CLICKHOUSE_OUTBOX_POLL_INTERVAL_MS,
    async run() {
      if ((await options.redis.exists("clickhouse:sink:pause")) === 1) return;
      const outcome = await processor.runBatch();
      recordClickHouseOutboxOutcome(metrics, outcome);
      if (outcome.status !== "idle") {
        logger.info("clickhouse.outbox.batch.completed", { ...outcome });
      }
    },
    onError(error) {
      metrics.recordSettlement({ stage: "clickhouse", status: "failed" });
      logger.error("clickhouse.outbox.batch.failed", error);
    },
  });
  pollers.push(
    clickHouseOutboxPoller,
    new SerialPoller({
      name: "clickhouse-metric-state",
      intervalMs: Math.max(environment.CLICKHOUSE_OUTBOX_POLL_INTERVAL_MS, 5_000),
      async run() {
        metrics.setClickHouseState(await metricState.read());
      },
      onError(error) {
        metrics.setClickHouseHealthy(false);
        logger.error("clickhouse.metric_state.failed", error);
      },
    }),
  );

  let reconciliationQueue: Queue<ReconciliationJobData> | null = null;
  let reconciliationWorker: Worker<ReconciliationJobData> | null = null;
  let schedules: { readonly hourly: boolean; readonly daily: boolean } | null = null;
  if (flags.reconciliation) {
    if (environment.RECONCILIATION_USER_HMAC_SECRET === undefined) {
      throw new TypeError("Reconciliation requires RECONCILIATION_USER_HMAC_SECRET");
    }
    const runner = new ReconciliationRunner(
      new PrismaReconciliationRepository(database),
      new DualStoreReconciliationSnapshotSource(database, options.clickhouse),
      {
        userHmacSecret: environment.RECONCILIATION_USER_HMAC_SECRET,
        tolerance: reconciliationTolerance(environment),
        logger: {
          info: (event, attributes) => logger.info(event, attributes),
          error: (event, attributes) => logger.error(event, new Error(event), attributes),
        },
      },
    );
    const connection = options.redis as unknown as ConnectionOptions;
    const operations = new PrismaReconciliationOperationExecutor(
      database,
      new ClickHouseScriptRebuildExecutor({
        evidenceDirectory: `${environment.EXPORT_DIRECTORY}/reconciliation`,
      }),
    );
    reconciliationQueue = createReconciliationQueue(connection);
    reconciliationWorker = createReconciliationWorker(connection, runner, operations);
    reconciliationWorker.on("completed", (job, result) => {
      recordReconciliationCompletion(
        metrics,
        job.data,
        result,
        job.finishedOn === undefined ? new Date() : new Date(job.finishedOn),
      );
    });
    reconciliationWorker.on("failed", (job, error) => {
      const configuredAttempts = job?.opts.attempts ?? 1;
      if (job === undefined || job.attemptsMade >= configuredAttempts) {
        metrics.recordReconciliation({
          runType: reconciliationRunType(job?.data),
          status: "failed",
        });
      }
      logger.error("reconciliation.job.failed", error, { job_id: job?.id ?? null });
    });
    schedules = {
      hourly: environment.RECONCILIATION_HOURLY_ENABLED,
      daily: environment.RECONCILIATION_DAILY_ENABLED,
    };
  }

  return new DataPlaneRuntime(
    pollers,
    options.clickhouse,
    reconciliationQueue,
    reconciliationWorker,
    schedules,
  );
}

import { Redis } from "ioredis";

import {
  checkClickHouseHealth,
  createClickHouseClient,
  loadClickHouseConfig,
} from "@tokenpilot/clickhouse";
import { createPrismaClient, registerDatabaseQueryObserver } from "@tokenpilot/db";
import {
  EXPORTS_GENERATE_QUEUE,
  MAINTENANCE_QUEUE,
  featureRuntimePrerequisitesFromEnvironment,
  loadWorkerEnvironment,
} from "@tokenpilot/shared";

import { loadValidatedWorkerFeatureFlags } from "./feature-configuration.js";
import { createDataPlaneRuntime } from "./data-plane-runtime.js";
import { OperationalProcessor } from "./operational-processor.js";
import { createOperationalWorker } from "./operational-worker.js";
import {
  closeMetricsServer,
  jobDurationMs,
  operationalErrorCode,
  serializeOperationalLog,
  startWorkerMetricsServer,
  WorkerObservability,
  type OperationalLog,
} from "./observability.js";
import { createWorkerReadinessProbe } from "./readiness.js";

const environment = loadWorkerEnvironment(process.env);
const database = createPrismaClient(environment.DATABASE_URL);
const clickhouseConfig = loadClickHouseConfig(process.env);
const clickhouse = createClickHouseClient(clickhouseConfig);
const clickhouseHealth = await checkClickHouseHealth(clickhouse);
if (!clickhouseHealth.ok) {
  await clickhouse.close();
  await database.$disconnect();
  throw new TypeError(`ClickHouse is required but unavailable: ${clickhouseHealth.error}`);
}
// PostgreSQL is authoritative after bootstrap. Environment feature flags are
// creation defaults owned by the API/seed path, never Worker runtime overrides.
const featureRuntimePrerequisites = featureRuntimePrerequisitesFromEnvironment(environment);
const instanceFeatureFlags = await loadValidatedWorkerFeatureFlags(
  database,
  featureRuntimePrerequisites,
  environment.AIU_MICRO_SCALE,
);
const redis = new Redis(environment.REDIS_URL, {
  enableReadyCheck: true,
  maxRetriesPerRequest: null,
});
const observability = new WorkerObservability(redis);
registerDatabaseQueryObserver(database, (observation) => {
  observability.observeDatabaseQuery(observation);
});
const operationalProcessor = new OperationalProcessor(database, {
  clickhouse,
  exportDirectory: environment.EXPORT_DIRECTORY,
  connectorStaleAfterSeconds: environment.CONNECTOR_STALE_AFTER_SECONDS,
});
const operationalWorkers = [
  createOperationalWorker(redis, EXPORTS_GENERATE_QUEUE, operationalProcessor, 2),
  createOperationalWorker(redis, MAINTENANCE_QUEUE, operationalProcessor, 2),
];
function log(input: Omit<OperationalLog, "component">): void {
  const line = serializeOperationalLog({ component: "worker", ...input });
  (input.level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}

const dataPlaneRuntime = createDataPlaneRuntime({
  database,
  redis,
  clickhouse,
  clickhouseConfig,
  environment,
  flags: instanceFeatureFlags,
  metrics: observability.platform,
  logger: {
    info: (event, attributes) =>
      log({ level: "info", event, ...(attributes === undefined ? {} : { attributes }) }),
    error: (event, error, attributes) =>
      log({
        level: "error",
        event,
        errorCode: operationalErrorCode(error),
        ...(attributes === undefined ? {} : { attributes }),
      }),
  },
});

log({
  level: "info",
  event: "worker.feature_flags.loaded",
  attributes: {
    refresh_policy: "startup_snapshot_restart_required",
    usage_pipeline: instanceFeatureFlags.usage_pipeline,
    model_resolution: instanceFeatureFlags.model_catalog,
    aiu: instanceFeatureFlags.aiu,
    quota: instanceFeatureFlags.quota,
    reconciliation: instanceFeatureFlags.reconciliation,
  },
});
for (const operationalWorker of operationalWorkers) {
  operationalWorker.on("completed", (job, result) => {
    const durationMs = jobDurationMs(job.processedOn);
    observability.observeJob("operational", "completed", durationMs);
    log({
      level: "info",
      event: "operational.job.completed",
      jobId: job.id,
      durationMs,
      attributes: { queue: operationalWorker.name, kind: result.kind },
    });
  });
  operationalWorker.on("failed", (job, error) => {
    const durationMs = jobDurationMs(job?.processedOn);
    observability.recordFailure("operational");
    observability.observeJob("operational", "failed", durationMs);
    log({
      level: "error",
      event: "operational.job.failed",
      jobId: job?.id,
      errorCode: operationalErrorCode(error),
      durationMs,
      attributes: { queue: operationalWorker.name, kind: job?.data.kind },
    });
  });
}

await Promise.all([
  ...operationalWorkers.map((operationalWorker) => operationalWorker.waitUntilReady()),
]);
let runtimeStarted = false;
await dataPlaneRuntime.start();
runtimeStarted = true;
const metricsServer = await startWorkerMetricsServer(observability, {
  host: environment.WORKER_METRICS_HOST,
  port: environment.WORKER_METRICS_PORT,
  readiness: createWorkerReadinessProbe({
    database,
    redis,
    checkClickHouse: () => dataPlaneRuntime.isClickHouseReady(),
    isStarted: () => runtimeStarted,
  }),
});
log({
  level: "info",
  event: "worker.metrics.listening",
  attributes: { port: environment.WORKER_METRICS_PORT },
});

async function shutdown(): Promise<void> {
  runtimeStarted = false;
  await closeMetricsServer(metricsServer);
  await Promise.all(operationalWorkers.map((operationalWorker) => operationalWorker.close()));
  await dataPlaneRuntime.close();
  await redis.quit();
  await database.$disconnect();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

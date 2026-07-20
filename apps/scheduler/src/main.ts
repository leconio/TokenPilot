import { Queue } from "bullmq";
import { Redis } from "ioredis";

import {
  MAINTENANCE_QUEUE,
  loadSchedulerEnvironment,
  type OperationalJobData,
} from "@tokenpilot/shared";

import { ControlPlaneScheduler } from "./scheduler.js";
import { schedulerErrorCode, serializeSchedulerLog } from "./observability.js";

const environment = loadSchedulerEnvironment(process.env);
const redis = new Redis(environment.REDIS_URL, {
  enableReadyCheck: true,
  maxRetriesPerRequest: null,
});
const maintenanceQueue = new Queue<OperationalJobData>(MAINTENANCE_QUEUE, { connection: redis });
const scheduler = new ControlPlaneScheduler(maintenanceQueue);

async function tick(): Promise<void> {
  const started = process.hrtime.bigint();
  try {
    const jobs = await scheduler.tick();
    process.stdout.write(
      `${serializeSchedulerLog({
        level: "info",
        event: "scheduler.tick.completed",
        durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
        jobs: jobs.length,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${serializeSchedulerLog({
        level: "error",
        event: "scheduler.tick.failed",
        errorCode: schedulerErrorCode(error),
        durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      })}\n`,
    );
  }
}

await tick();
const timer = setInterval(() => void tick(), 60_000);

async function shutdown(): Promise<void> {
  clearInterval(timer);
  await maintenanceQueue.close();
  await redis.quit();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

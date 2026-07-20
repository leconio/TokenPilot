import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";

import {
  RECONCILIATION_DAILY_JOB,
  RECONCILIATION_HOURLY_JOB,
  RECONCILIATION_MANUAL_JOB,
  RECONCILIATION_QUEUE,
  type ReconciliationJobData,
} from "@tokenpilot/shared";

import type { ReconciliationRunner } from "./runner.js";
import type { PrismaReconciliationOperationExecutor } from "./operation-executor.js";
import { scheduledReconciliationIdempotencyKey, scheduledReconciliationPlan } from "./schedule.js";

export interface ReconciliationScheduleOptions {
  readonly hourly: boolean;
  readonly daily: boolean;
}

export async function configureReconciliationSchedules(
  queue: Queue<ReconciliationJobData>,
  options: ReconciliationScheduleOptions,
): Promise<void> {
  if (options.hourly) {
    await queue.upsertJobScheduler(
      "reconciliation-hourly",
      { pattern: "7 * * * *", tz: "UTC" },
      {
        name: RECONCILIATION_HOURLY_JOB,
        data: { kind: "schedule", runType: "hourly" },
        opts: { removeOnComplete: 100, removeOnFail: 1_000 },
      },
    );
  } else {
    await queue.removeJobScheduler("reconciliation-hourly");
  }
  if (options.daily) {
    await queue.upsertJobScheduler(
      "reconciliation-daily",
      { pattern: "17 1 * * *", tz: "UTC" },
      {
        name: RECONCILIATION_DAILY_JOB,
        data: { kind: "schedule", runType: "daily" },
        opts: { removeOnComplete: 100, removeOnFail: 1_000 },
      },
    );
  } else {
    await queue.removeJobScheduler("reconciliation-daily");
  }
}

export function createReconciliationQueue(
  connection: ConnectionOptions,
): Queue<ReconciliationJobData> {
  return new Queue<ReconciliationJobData>(RECONCILIATION_QUEUE, { connection });
}

export function createReconciliationWorker(
  connection: ConnectionOptions,
  runner: ReconciliationRunner,
  operations?: PrismaReconciliationOperationExecutor,
  concurrency = 1,
): Worker<ReconciliationJobData> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new RangeError("reconciliation concurrency must be between 1 and 16");
  }
  return new Worker<ReconciliationJobData>(
    RECONCILIATION_QUEUE,
    async (job: Job<ReconciliationJobData>) => {
      if (job.data.kind === "run") {
        return runner.execute(job.data.runId);
      }
      if (job.data.kind === "replay") {
        if (operations === undefined)
          throw new Error("Reconciliation replay executor is unavailable");
        return operations.executeReplay(job.data.runId);
      }
      if (job.data.kind === "rebuild") {
        if (operations === undefined) throw new Error("ClickHouse rebuild executor is unavailable");
        return operations.executeRebuild(job.data.runId);
      }
      const summaries = [];
      for (const applicationId of await runner.applicationIds()) {
        const plan = scheduledReconciliationPlan(
          applicationId,
          job.data.runType,
          new Date(job.timestamp),
        );
        const queued = await runner.queue(plan, null, scheduledReconciliationIdempotencyKey(plan));
        summaries.push(await runner.execute(queued.id));
      }
      return summaries;
    },
    { connection, concurrency },
  );
}

export async function enqueueManualReconciliation(
  queue: Queue<ReconciliationJobData>,
  runId: string,
): Promise<void> {
  await queue.add(
    RECONCILIATION_MANUAL_JOB,
    { kind: "run", runId },
    {
      jobId: `reconciliation-run-${runId}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 1_000,
    },
  );
}

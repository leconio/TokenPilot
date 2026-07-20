import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";

import {
  BackgroundJobStatus,
  BackgroundJobType,
  type DatabaseClient,
  type Prisma,
} from "@tokenpilot/db";
import { EXPORTS_GENERATE_JOB } from "@tokenpilot/shared";

import type { ExportQueue } from "./infrastructure.js";
import { DATABASE_CLIENT, EXPORT_QUEUE } from "./tokens.js";

const RECOVERY_INTERVAL_MS = 5_000;
const RECOVERY_BATCH_SIZE = 100;
const RECOVERY_CONCURRENCY = 10;
const RECOVERY_SCAN_TIMEOUT_MS = 3_000;
const QUEUE_OPERATION_TIMEOUT_MS = 2_000;

export interface RecoverableBackgroundJob {
  readonly id: string;
  readonly applicationId: string | null;
  readonly type: BackgroundJobType;
  readonly status: BackgroundJobStatus;
  readonly idempotencyKey: string;
  readonly parametersJson: Prisma.JsonValue;
}

export interface BackgroundJobRecoveryResult {
  readonly scanned: number;
  readonly enqueued: number;
  readonly alreadyPresent: number;
  readonly failed: number;
}

export class QueueOperationTimeoutError extends Error {
  constructor() {
    super("Queue operation timed out");
    this.name = "QueueOperationTimeoutError";
  }
}

/**
 * Bounds API and recovery calls even though BullMQ's shared Redis connection is configured to
 * survive transient disconnects. The underlying command may finish after Redis reconnects; the
 * deterministic job ID makes that late completion safe.
 */
export async function withQueueAvailabilityTimeout<T>(
  operation: Promise<T>,
  timeoutMs = QUEUE_OPERATION_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new QueueOperationTimeoutError()), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parameters(value: Prisma.JsonValue): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Persisted background job parameters must be a JSON object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function jobOptions(jobId: string) {
  return {
    jobId,
    attempts: 8,
    backoff: { type: "exponential" as const, delay: 1000, jitter: 0.5 },
    removeOnComplete: false,
    removeOnFail: false,
  };
}

@Injectable()
export class BackgroundJobRecoveryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BackgroundJobRecoveryService.name);
  private recovery: Promise<BackgroundJobRecoveryResult> | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(EXPORT_QUEUE) private readonly exportQueue: ExportQueue,
  ) {}

  onApplicationBootstrap(): void {
    void this.recoverPending().catch((error: unknown) => {
      this.logger.warn({ error: this.errorName(error) }, "Initial background-job recovery failed");
    });
    this.timer = setInterval(() => {
      void this.recoverPending().catch((error: unknown) => {
        this.logger.warn({ error: this.errorName(error) }, "Background-job recovery scan failed");
      });
    }, RECOVERY_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Coalesces overlapping scans in one API process; fixed BullMQ IDs cover multi-process races. */
  recoverPending(): Promise<BackgroundJobRecoveryResult> {
    if (this.recovery !== undefined) return this.recovery;
    const recovery = this.scan().finally(() => {
      if (this.recovery === recovery) this.recovery = undefined;
    });
    this.recovery = recovery;
    return recovery;
  }

  async enqueue(
    job: RecoverableBackgroundJob,
    timeoutMs = QUEUE_OPERATION_TIMEOUT_MS,
  ): Promise<"enqueued" | "already_present"> {
    if (job.status !== BackgroundJobStatus.QUEUED) return "already_present";
    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    if (job.type !== BackgroundJobType.EXPORTS_GENERATE) {
      throw new TypeError(`Unsupported background job type: ${job.type}`);
    }
    const existing = await withQueueAvailabilityTimeout(
      this.exportQueue.getJob(job.id),
      remaining(),
    );
    if (existing !== undefined) return "already_present";

    const jobParameters = parameters(job.parametersJson);
    const data = {
      backgroundJobId: job.id,
      ...(job.applicationId === null ? {} : { applicationId: job.applicationId }),
      kind: "exports.generate" as const,
      idempotencyKey: job.idempotencyKey,
      parameters: jobParameters,
    };
    await withQueueAvailabilityTimeout(
      this.exportQueue.add(EXPORTS_GENERATE_JOB, data, jobOptions(job.id)),
      remaining(),
    );
    return "enqueued";
  }

  private async scan(): Promise<BackgroundJobRecoveryResult> {
    const rows = await this.database.backgroundJob.findMany({
      where: {
        status: BackgroundJobStatus.QUEUED,
        type: BackgroundJobType.EXPORTS_GENERATE,
        OR: [{ scheduledFor: null }, { scheduledFor: { lte: new Date() } }],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: RECOVERY_BATCH_SIZE,
    });
    let cursor = 0;
    let scanned = 0;
    let enqueued = 0;
    let alreadyPresent = 0;
    let failed = 0;
    const deadline = Date.now() + RECOVERY_SCAN_TIMEOUT_MS;
    const recover = async () => {
      while (Date.now() < deadline) {
        const index = cursor;
        cursor += 1;
        const row = rows[index];
        if (row === undefined) return;
        scanned += 1;
        try {
          const result = await this.enqueue(
            row as RecoverableBackgroundJob,
            Math.max(1, deadline - Date.now()),
          );
          if (result === "enqueued") enqueued += 1;
          else alreadyPresent += 1;
        } catch (error) {
          failed += 1;
          this.logger.warn(
            { backgroundJobId: row.id, error: this.errorName(error) },
            "Persisted background job remains queued for a later recovery scan",
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(RECOVERY_CONCURRENCY, rows.length) }, () => recover()),
    );
    return { scanned, enqueued, alreadyPresent, failed };
  }

  private errorName(error: unknown): string {
    return error instanceof Error ? error.name : "UnknownError";
  }
}

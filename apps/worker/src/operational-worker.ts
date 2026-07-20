import { Worker } from "bullmq";
import type { Redis } from "ioredis";

import type { OperationalJobData } from "@tokenpilot/shared";

import type { OperationalOutcome, OperationalProcessor } from "./operational-processor.js";

export function createOperationalWorker(
  redis: Redis,
  queueName: string,
  processor: OperationalProcessor,
  concurrency = 2,
): Worker<OperationalJobData, OperationalOutcome, string> {
  return new Worker<OperationalJobData, OperationalOutcome, string>(
    queueName,
    (job) => processor.process(job.data),
    { connection: redis, concurrency },
  );
}

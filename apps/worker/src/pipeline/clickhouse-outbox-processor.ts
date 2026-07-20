import {
  CLICKHOUSE_PIPELINE_EVENT_TYPES,
  type ClickHouseOutboxBatchSink,
  type ClickHouseOutboxDeliveryResult,
} from "@tokenpilot/clickhouse";

import { retryDelayMs } from "./errors.js";
import {
  outboxLeaseRecord,
  type OutboxFailure,
  type PrismaClickHouseOutboxStore,
} from "./prisma-outbox-store.js";
import type { OutboxLease } from "./types.js";

export interface ClickHouseOutboxProcessorOptions {
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly retryBaseDelayMs?: number;
}

export interface ClickHouseOutboxBatchOutcome {
  readonly status: "idle" | "delivered" | "retry_scheduled" | "dead_lettered";
  readonly leased: number;
  readonly delivered: number;
  readonly retried: number;
  readonly deadLettered: number;
}

function failureFrom(error: unknown): OutboxFailure {
  const permanent = error instanceof TypeError || error instanceof RangeError;
  return {
    code: permanent ? "CLICKHOUSE_OUTBOX_PAYLOAD_INVALID" : "CLICKHOUSE_DELIVERY_FAILED",
    errorClass: error instanceof Error ? error.constructor.name : "UnknownClickHouseError",
    message: error instanceof Error ? error.message : "Unknown ClickHouse delivery failure",
    retryable: !permanent,
  };
}

/** Drains only CH-owned outbox types. A CH failure becomes PG retry state, never an ingestion failure. */
export class ClickHouseOutboxProcessor {
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;

  constructor(
    private readonly store: PrismaClickHouseOutboxStore,
    private readonly sink: ClickHouseOutboxBatchSink,
    options: ClickHouseOutboxProcessorOptions,
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.maxAttempts = options.maxAttempts ?? 12;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 1_000) {
      throw new RangeError("ClickHouse outbox batch size must be between 1 and 1000");
    }
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new RangeError("ClickHouse outbox max attempts must be a positive integer");
    }
  }

  async runBatch(): Promise<ClickHouseOutboxBatchOutcome> {
    // PostgreSQL does not guarantee the order of UPDATE ... RETURNING rows. Keep the
    // batch in the same canonical order used by the ClickHouse sink so identity
    // acknowledgements and the max-outbox watermark cannot diverge by array position.
    const leases = [
      ...(await this.store.leaseOutbox(CLICKHOUSE_PIPELINE_EVENT_TYPES, this.batchSize)),
    ].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    if (leases.length === 0) {
      return { status: "idle", leased: 0, delivered: 0, retried: 0, deadLettered: 0 };
    }
    let result: ClickHouseOutboxDeliveryResult;
    try {
      result = await this.sink.deliver(leases.map(outboxLeaseRecord));
    } catch (error) {
      return this.handleFailure(leases, failureFrom(error));
    }
    // Do not translate a lost PG fence into another stale mutation. If this
    // acknowledgement fails, the lease expires and a later owner safely
    // replays against stable CH delivery IDs.
    await this.store.markDelivered(leases, result);
    return {
      status: "delivered",
      leased: leases.length,
      delivered: leases.length,
      retried: 0,
      deadLettered: 0,
    };
  }

  private async handleFailure(
    leases: readonly OutboxLease[],
    failure: OutboxFailure,
  ): Promise<ClickHouseOutboxBatchOutcome> {
    let retried = 0;
    let deadLettered = 0;
    for (const lease of leases) {
      if (failure.retryable && lease.attemptCount < this.maxAttempts) {
        await this.store.retry(
          lease,
          failure,
          new Date(Date.now() + retryDelayMs(lease.attemptCount, this.retryBaseDelayMs)),
        );
        retried += 1;
      } else {
        await this.store.deadLetter(
          lease,
          failure.retryable
            ? {
                ...failure,
                code: "CLICKHOUSE_DELIVERY_RETRY_EXHAUSTED",
                retryable: false,
              }
            : failure,
        );
        deadLettered += 1;
      }
    }
    return {
      status: retried > 0 ? "retry_scheduled" : "dead_lettered",
      leased: leases.length,
      delivered: 0,
      retried,
      deadLettered,
    };
  }
}

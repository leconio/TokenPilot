import { describe, expect, it, vi } from "vitest";

import type {
  ClickHouseOutboxBatchSink,
  ClickHouseOutboxDeliveryResult,
} from "@tokenpilot/clickhouse";

import { ClickHouseOutboxProcessor } from "../../src/pipeline/clickhouse-outbox-processor.js";
import type { PrismaClickHouseOutboxStore } from "../../src/pipeline/prisma-outbox-store.js";
import type { OutboxLease } from "../../src/pipeline/types.js";

function lease(overrides: Partial<OutboxLease> = {}): OutboxLease {
  return {
    id: 42n,
    applicationId: "00000000-0000-4000-8000-000000000001",
    aggregateType: "usage_event",
    aggregateId: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
    eventType: "usage_events_raw",
    payload: { schema_version: "test" },
    idempotencyKey: "raw:42",
    replayOfOutboxId: null,
    attemptCount: 1,
    leaseOwner: "worker:42",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date("2026-07-16T00:00:00.000Z"),
    ...overrides,
  };
}

function fixture(items: readonly OutboxLease[] = [lease()]) {
  const canonicalItems = [...items].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  const delivery: ClickHouseOutboxDeliveryResult = {
    outboxIds: canonicalItems.map((item) => item.id),
    rowCount: items.length,
    maxOutboxId: canonicalItems.at(-1)?.id ?? 0n,
    maxEventTime: new Date("2026-07-16T00:00:00.000Z"),
  };
  const store = {
    leaseOutbox: vi.fn(async () => items),
    markDelivered: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    deadLetter: vi.fn(async () => undefined),
  } as unknown as PrismaClickHouseOutboxStore;
  const sink = {
    deliver: vi.fn(async () => delivery),
  } as unknown as ClickHouseOutboxBatchSink;
  return { store, sink, delivery };
}

describe("ClickHouseOutboxProcessor", () => {
  it("marks PG outboxes only after the sink confirms rows and watermark", async () => {
    const f = fixture();
    const processor = new ClickHouseOutboxProcessor(f.store, f.sink, {});

    await expect(processor.runBatch()).resolves.toEqual({
      status: "delivered",
      leased: 1,
      delivered: 1,
      retried: 0,
      deadLettered: 0,
    });
    expect(f.sink.deliver).toHaveBeenCalledOnce();
    expect(f.store.markDelivered).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 42n })],
      f.delivery,
    );
  });

  it("canonicalizes an unordered PostgreSQL RETURNING batch before delivery and acknowledgement", async () => {
    const f = fixture([
      lease({ id: 44n, leaseOwner: "worker:44" }),
      lease({ id: 42n, leaseOwner: "worker:42" }),
      lease({ id: 43n, leaseOwner: "worker:43" }),
    ]);

    await expect(
      new ClickHouseOutboxProcessor(f.store, f.sink, {}).runBatch(),
    ).resolves.toMatchObject({ status: "delivered", leased: 3, delivered: 3 });

    expect(vi.mocked(f.sink.deliver).mock.calls[0]?.[0].map((item) => item.id)).toEqual([
      42n,
      43n,
      44n,
    ]);
    expect(vi.mocked(f.store.markDelivered).mock.calls[0]?.[0].map((item) => item.id)).toEqual([
      42n,
      43n,
      44n,
    ]);
    expect(f.store.markDelivered).toHaveBeenCalledWith(expect.any(Array), {
      ...f.delivery,
      outboxIds: [42n, 43n, 44n],
      maxOutboxId: 44n,
    });
  });

  it("turns ClickHouse unavailability into fenced PG retry state", async () => {
    const f = fixture();
    vi.mocked(f.sink.deliver).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const processor = new ClickHouseOutboxProcessor(f.store, f.sink, {
      retryBaseDelayMs: 1,
    });

    await expect(processor.runBatch()).resolves.toMatchObject({
      status: "retry_scheduled",
      delivered: 0,
      retried: 1,
    });
    expect(f.store.markDelivered).not.toHaveBeenCalled();
    expect(f.store.retry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42n }),
      expect.objectContaining({ code: "CLICKHOUSE_DELIVERY_FAILED", retryable: true }),
      expect.any(Date),
    );
  });

  it("dead-letters invalid payloads and exhausted transient deliveries", async () => {
    const invalid = fixture();
    vi.mocked(invalid.sink.deliver).mockRejectedValueOnce(new TypeError("bad outbox payload"));
    await new ClickHouseOutboxProcessor(invalid.store, invalid.sink, {}).runBatch();
    expect(invalid.store.deadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42n }),
      expect.objectContaining({ code: "CLICKHOUSE_OUTBOX_PAYLOAD_INVALID", retryable: false }),
    );

    const exhausted = fixture([lease({ attemptCount: 3 })]);
    vi.mocked(exhausted.sink.deliver).mockRejectedValueOnce(new Error("timeout"));
    await new ClickHouseOutboxProcessor(exhausted.store, exhausted.sink, {
      maxAttempts: 3,
    }).runBatch();
    expect(exhausted.store.retry).not.toHaveBeenCalled();
    expect(exhausted.store.deadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42n }),
      expect.objectContaining({ code: "CLICKHOUSE_DELIVERY_RETRY_EXHAUSTED" }),
    );
  });
});

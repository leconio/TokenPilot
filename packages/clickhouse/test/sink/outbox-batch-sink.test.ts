import { describe, expect, it, vi } from "vitest";

import { ClickHouseOutboxBatchSink, type ClickHouseOperations } from "../../src/index.js";
import { normalized, record } from "./outbox-sink.fixtures.js";

describe("ClickHouse outbox batch sink", () => {
  const rawRecord = record(40n, "usage_events_raw", {
    event: { ...normalized, usage: { request_count: "1" } },
    normalized,
    resolution: { modelId: "base-model-1" },
    payload_hash: "a".repeat(64),
  });
  const usageRecord = record(41n, "usage_lines", {
    normalized,
    resolution: { modelId: "base-model-1" },
  });

  it("does not advance the watermark when any table insert fails", async () => {
    const insertRows = vi
      .fn()
      .mockResolvedValueOnce({ queryIds: ["raw"], batches: 1, rows: 1, bytes: 1 })
      .mockRejectedValueOnce(new Error("ClickHouse unavailable"));
    const sink = new ClickHouseOutboxBatchSink(
      {
        insertRows,
        queryRows: vi.fn(async () => ({ queryId: "dedup", rows: [] })),
      } as unknown as ClickHouseOperations,
      { environment: "test" },
    );

    await expect(sink.deliver([rawRecord, usageRecord])).rejects.toThrowError(
      "ClickHouse unavailable",
    );
    expect(insertRows).toHaveBeenCalledTimes(2);
    expect(insertRows.mock.calls.some(([call]) => call.table === "pipeline_watermarks")).toBe(
      false,
    );
  });

  it("waits for all tables before appending the max outbox watermark", async () => {
    const insertRows = vi
      .fn()
      .mockResolvedValue({ queryIds: ["ok"], batches: 1, rows: 1, bytes: 1 });
    const queryRows = vi.fn(async () => ({ queryId: "dedup", rows: [] }));
    const sink = new ClickHouseOutboxBatchSink(
      { insertRows, queryRows } as unknown as ClickHouseOperations,
      {
        environment: "test",
        now: () => new Date("2026-07-16T00:01:00.000Z"),
      },
    );

    await expect(sink.deliver([usageRecord, rawRecord, rawRecord])).resolves.toMatchObject({
      outboxIds: [40n, 41n],
      rowCount: 2,
      maxOutboxId: 41n,
    });
    expect(insertRows.mock.calls.map(([call]) => call.table)).toEqual([
      "usage_events_raw",
      "usage_lines",
      "pipeline_watermarks",
    ]);
    expect(insertRows.mock.calls.at(-1)?.[0]).toMatchObject({
      rows: [expect.objectContaining({ watermark_outbox_id: "41", version: "41" })],
    });
  });

  it("skips stable delivery IDs already acknowledged by ClickHouse on replay", async () => {
    const insertRows = vi
      .fn()
      .mockResolvedValue({ queryIds: ["watermark"], batches: 1, rows: 1, bytes: 1 });
    const queryRows = vi.fn(async (request: { queryParams: { deliveryIds: string[] } }) => ({
      queryId: "dedup",
      rows: request.queryParams.deliveryIds.map((sink_delivery_id) => ({ sink_delivery_id })),
    }));
    const sink = new ClickHouseOutboxBatchSink(
      { insertRows, queryRows } as unknown as ClickHouseOperations,
      { environment: "test" },
    );

    await expect(sink.deliver([rawRecord, usageRecord])).resolves.toMatchObject({ rowCount: 0 });
    expect(insertRows).toHaveBeenCalledTimes(1);
    expect(insertRows).toHaveBeenCalledWith(
      expect.objectContaining({ table: "pipeline_watermarks" }),
    );
  });

  it("does not duplicate a late original delivery when its audited clone is processed", async () => {
    const insertRows = vi
      .fn()
      .mockResolvedValue({ queryIds: ["watermark"], batches: 1, rows: 1, bytes: 1 });
    const queryRows = vi.fn(async (request: { queryParams: { deliveryIds: string[] } }) => ({
      queryId: "dedup",
      rows: request.queryParams.deliveryIds.includes("outbox:40:raw")
        ? [{ sink_delivery_id: "outbox:40:raw" }]
        : [],
    }));
    const sink = new ClickHouseOutboxBatchSink(
      { insertRows, queryRows } as unknown as ClickHouseOperations,
      { environment: "test" },
    );
    const clone = { ...rawRecord, id: 100n, replayOfOutboxId: 40n };

    await expect(sink.deliver([clone])).resolves.toMatchObject({
      outboxIds: [100n],
      rowCount: 0,
      maxOutboxId: 100n,
    });
    expect(queryRows).toHaveBeenCalledWith(
      expect.objectContaining({ queryParams: { deliveryIds: ["outbox:40:raw"] } }),
    );
    expect(insertRows).toHaveBeenCalledTimes(1);
    expect(insertRows).toHaveBeenCalledWith(
      expect.objectContaining({ table: "pipeline_watermarks" }),
    );
  });
});

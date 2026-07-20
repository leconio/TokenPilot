import { describe, expect, it, vi } from "vitest";

import {
  readClickHousePipelineWatermark,
  writeClickHousePipelineWatermark,
  type ClickHouseOperations,
} from "../src/index.js";

describe("ClickHouse pipeline watermarks", () => {
  it("writes append-only versions without error messages", async () => {
    const insertRows = vi.fn().mockResolvedValue({ queryIds: [], batches: 1, rows: 1, bytes: 0 });
    const operations = { insertRows } as unknown as ClickHouseOperations;

    await writeClickHousePipelineWatermark(operations, {
      pipelineName: "official_delta",
      watermarkType: "outbox_id",
      cursor: "42",
      eventTime: new Date("2026-07-16T01:02:03.456Z"),
      outboxId: 42n,
      lagSeconds: 3,
      status: "healthy",
      updatedAt: new Date("2026-07-16T02:03:04.567Z"),
      version: 7n,
    });

    expect(insertRows).toHaveBeenCalledWith(
      expect.objectContaining({
        table: "pipeline_watermarks",
        rows: [
          expect.objectContaining({
            pipeline_name: "official_delta",
            cursor: "42",
            watermark_event_time: "2026-07-16 01:02:03.456",
            watermark_outbox_id: "42",
            lag_seconds: 3,
            error_class: "",
            version: "7",
          }),
        ],
      }),
    );
  });

  it("reads the latest version through argMax without FINAL", async () => {
    const queryRows = vi.fn(async (request) => ({
      queryId: "watermark-query",
      rows: [
        request.map({
          pipeline_name: "official_delta",
          watermark_type: "outbox_id",
          cursor: "42",
          watermark_event_time: "2026-07-16 01:02:03.456",
          watermark_outbox_id: "42",
          lag_seconds: 3,
          status: "healthy",
          error_class: "",
          updated_at: "2026-07-16 02:03:04.567",
          version: "7",
        }),
      ],
    }));
    const operations = { queryRows } as unknown as ClickHouseOperations;

    await expect(
      readClickHousePipelineWatermark(operations, "official_delta"),
    ).resolves.toMatchObject({
      pipelineName: "official_delta",
      cursor: "42",
      outboxId: "42",
      lagSeconds: 3,
      version: "7",
    });
    const request = queryRows.mock.calls[0]?.[0] as { query: string; queryParams: unknown };
    expect(request.query).toContain("argMax(");
    expect(request.query).toContain("GROUP BY pipeline_name");
    expect(request.query).not.toContain("FINAL");
    expect(request.queryParams).toEqual({ pipelineName: "official_delta" });
  });

  it("rejects invalid unsigned watermark values before insertion", async () => {
    const insertRows = vi.fn();
    const operations = { insertRows } as unknown as ClickHouseOperations;

    await expect(
      writeClickHousePipelineWatermark(operations, {
        pipelineName: "official_delta",
        watermarkType: "outbox_id",
        cursor: "-1",
        outboxId: -1n,
        lagSeconds: -1,
        status: "failed",
        version: 0n,
      }),
    ).rejects.toThrowError(/watermark/u);
    expect(insertRows).not.toHaveBeenCalled();
  });
});

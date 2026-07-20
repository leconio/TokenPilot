import type { ClickHouseClient } from "@clickhouse/client";
import { describe, expect, it, vi } from "vitest";

import {
  ClickHouseOperations,
  loadClickHouseConfig,
  type ClickHouseOperationMetric,
} from "../../src/index.js";

function config(overrides: NodeJS.ProcessEnv = {}) {
  return loadClickHouseConfig({
    CLICKHOUSE_PASSWORD: "unit-test-password",
    CLICKHOUSE_INSERT_BATCH_SIZE: "2",
    CLICKHOUSE_INSERT_FLUSH_MS: "25",
    CLICKHOUSE_SAFE_RETRY_ATTEMPTS: "2",
    CLICKHOUSE_SAFE_RETRY_BASE_DELAY_MS: "1",
    ...overrides,
  });
}

function queryResult(
  rows: readonly unknown[],
  queryId = "server-query-id",
  summary = { result_rows: String(rows.length), result_bytes: "128" },
) {
  return {
    query_id: queryId,
    response_headers: { "x-clickhouse-summary": JSON.stringify(summary) },
    json: vi.fn().mockResolvedValue(rows),
  };
}

describe("ClickHouse production operations", () => {
  it("maps parameterized readonly queries and records only redacted metadata", async () => {
    const query = vi.fn().mockResolvedValue(queryResult([{ total: "2" }]));
    const metrics: ClickHouseOperationMetric[] = [];
    const operations = new ClickHouseOperations(
      { query } as unknown as ClickHouseClient,
      config(),
      {
        record: (metric) => {
          metrics.push(metric);
        },
      },
    );

    await expect(
      operations.queryRows<{ total: string }, number>({
        name: "usage.total",
        query: "SELECT {secret:String} AS total",
        queryParams: { secret: "sensitive-dimension-value" },
        map: (row) => Number(row.total),
      }),
    ).resolves.toMatchObject({ rows: [2] });

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: { secret: "sensitive-dimension-value" },
        clickhouse_settings: expect.objectContaining({ readonly: "1", max_execution_time: 10 }),
      }),
    );
    expect(metrics).toEqual([
      expect.objectContaining({
        operation: "query",
        name: "usage.total",
        queryId: "server-query-id",
        rows: 1,
        bytes: 128,
        outcome: "success",
      }),
    ]);
    expect(JSON.stringify(metrics)).not.toContain("sensitive-dimension-value");
    expect(JSON.stringify(metrics)).not.toContain("SELECT");
    expect(JSON.stringify(metrics)).not.toContain("unit-test-password");
  });

  it("retries transient readonly failures but not semantic failures", async () => {
    const transient = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    const query = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(queryResult([{ ok: 1 }]));
    const operations = new ClickHouseOperations({ query } as unknown as ClickHouseClient, config());

    await expect(
      operations.queryRows<{ ok: number }>({ name: "health.read", query: "SELECT 1 AS ok" }),
    ).resolves.toMatchObject({ rows: [{ ok: 1 }] });
    expect(query).toHaveBeenCalledTimes(2);

    const semanticQuery = vi.fn().mockRejectedValue(new Error("syntax error"));
    await expect(
      new ClickHouseOperations(
        { query: semanticQuery } as unknown as ClickHouseClient,
        config(),
      ).queryRows({ name: "invalid.read", query: "SELEC 1" }),
    ).rejects.toThrowError("syntax error");
    expect(semanticQuery).toHaveBeenCalledTimes(1);
  });

  it("enforces a per-query timeout without retrying the aborted read", async () => {
    const query = vi.fn(
      async ({ abort_signal: signal }: { abort_signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const operations = new ClickHouseOperations({ query } as unknown as ClickHouseClient, config());

    await expect(
      operations.queryRows({ name: "timeout.read", query: "SELECT sleep(10)", timeoutMs: 5 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("splits inserts, waits for async flush, and never retries an uncertain write", async () => {
    const insert = vi
      .fn()
      .mockResolvedValueOnce({
        query_id: "insert-1",
        summary: { written_rows: "2", written_bytes: "64" },
      })
      .mockResolvedValueOnce({
        query_id: "insert-2",
        summary: { written_rows: "2", written_bytes: "64" },
      })
      .mockResolvedValueOnce({
        query_id: "insert-3",
        summary: { written_rows: "1", written_bytes: "32" },
      });
    const operations = new ClickHouseOperations(
      { insert } as unknown as ClickHouseClient,
      config(),
    );
    const rows = Array.from({ length: 5 }, (_, id) => ({ id }));

    await expect(
      operations.insertRows({ name: "usage.insert", table: "usage_lines", rows }),
    ).resolves.toEqual({
      queryIds: ["insert-1", "insert-2", "insert-3"],
      batches: 3,
      rows: 5,
      bytes: 160,
    });
    expect(insert).toHaveBeenCalledTimes(3);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        table: "ai_control_plane.usage_lines",
        values: rows.slice(0, 2),
        clickhouse_settings: expect.objectContaining({
          async_insert: 1,
          wait_for_async_insert: 1,
          async_insert_busy_timeout_max_ms: 25,
        }),
      }),
    );

    const uncertainInsert = vi.fn().mockRejectedValue(new Error("response lost"));
    await expect(
      new ClickHouseOperations(
        { insert: uncertainInsert } as unknown as ClickHouseClient,
        config(),
      ).insertRows({ name: "usage.insert", table: "usage_lines", rows: [{ id: 1 }] }),
    ).rejects.toThrowError("response lost");
    expect(uncertainInsert).toHaveBeenCalledTimes(1);
  });

  it("does not let metrics failures alter successful reads", async () => {
    const operations = new ClickHouseOperations(
      { query: vi.fn().mockResolvedValue(queryResult([{ ok: 1 }])) } as unknown as ClickHouseClient,
      config(),
      { record: () => Promise.reject(new Error("metrics unavailable")) },
    );

    await expect(
      operations.queryRows({ name: "metrics.read", query: "SELECT 1 AS ok" }),
    ).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });

  it("does not expose arbitrary upstream error names as metric labels", async () => {
    const error = new Error("private details");
    error.name = "CustomerSecretError";
    const metrics: ClickHouseOperationMetric[] = [];
    const operations = new ClickHouseOperations(
      { query: vi.fn().mockRejectedValue(error) } as unknown as ClickHouseClient,
      config(),
      {
        record: (metric) => {
          metrics.push(metric);
        },
      },
    );

    await expect(operations.queryRows({ name: "error.read", query: "SELECT 1" })).rejects.toBe(
      error,
    );
    expect(metrics[0]).toMatchObject({ errorClass: "ClickHouseError" });
    expect(JSON.stringify(metrics)).not.toContain("CustomerSecretError");
  });
});

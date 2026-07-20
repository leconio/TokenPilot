import { randomUUID } from "node:crypto";

import type { ClickHouseClient, ClickHouseSettings } from "@clickhouse/client";

import { assertClickHouseIdentifier, type ClickHouseRuntimeConfig } from "../config.js";
import {
  assertClickHouseMetricName,
  clickHouseErrorClass,
  clickHouseSummaryCounts,
  recordClickHouseMetric,
  summaryFromHeaders,
} from "../metrics/record.js";
import { NOOP_CLICKHOUSE_METRICS, type ClickHouseMetricsSink } from "../metrics/types.js";
import { isTransientClickHouseReadError, retryDelayMs, waitBeforeRetry } from "./retry.js";

export interface ClickHouseReadRequest<T, Mapped = T> {
  readonly name: string;
  readonly query: string;
  readonly queryParams?: Readonly<Record<string, unknown>>;
  readonly settings?: ClickHouseSettings;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly map?: (row: T, index: number) => Mapped;
}

export interface ClickHouseReadResult<T> {
  readonly queryId: string;
  readonly rows: readonly T[];
}

export interface ClickHouseInsertRequest<T extends Record<string, unknown>> {
  readonly name: string;
  readonly table: string;
  readonly rows: readonly T[];
  readonly columns?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ClickHouseInsertResult {
  readonly queryIds: readonly string[];
  readonly batches: number;
  readonly rows: number;
  readonly bytes: number;
}

interface TimedSignal {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
}

function timedSignal(timeoutMs: number, external?: AbortSignal): TimedSignal {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const onExternalAbort = () => controller.abort(external?.reason);
  if (external?.aborted === true) onExternalAbort();
  else external?.addEventListener("abort", onExternalAbort, { once: true });
  const timeout = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort(new DOMException("ClickHouse operation timed out", "TimeoutError"));
  }, timeoutMs);
  timeout.unref();
  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    dispose: () => {
      clearTimeout(timeout);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

function queryId(name: string, operation: "query" | "insert"): string {
  const safeName = name.replaceAll(/[^a-z0-9]+/gu, "_");
  return `ai_control_${operation}_${safeName}_${randomUUID()}`;
}

function durationMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function nonEmptyColumns(
  columns: readonly string[] | undefined,
): [string, ...string[]] | undefined {
  if (columns === undefined) return undefined;
  if (columns.length === 0) throw new Error("ClickHouse insert columns must not be empty");
  const checked = columns.map((column) => assertClickHouseIdentifier(column, "ClickHouse column"));
  return checked as [string, ...string[]];
}

export class ClickHouseOperations {
  public constructor(
    private readonly client: ClickHouseClient,
    private readonly config: ClickHouseRuntimeConfig,
    private readonly metrics: ClickHouseMetricsSink = NOOP_CLICKHOUSE_METRICS,
  ) {}

  public async queryRows<T, Mapped = T>(
    request: ClickHouseReadRequest<T, Mapped>,
  ): Promise<ClickHouseReadResult<Mapped>> {
    const name = assertClickHouseMetricName(request.name);
    const timeoutMs = request.timeoutMs ?? this.config.requestTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
      throw new Error("ClickHouse query timeout must be between 1 and 300000 milliseconds");
    }

    for (let attempt = 1; attempt <= this.config.safeRetryAttempts; attempt += 1) {
      const id = queryId(name, "query");
      const startedAt = performance.now();
      const timed = timedSignal(timeoutMs, request.signal);
      try {
        const result = await this.client.query({
          query: request.query,
          format: "JSONEachRow",
          query_id: id,
          abort_signal: timed.signal,
          ...(request.queryParams === undefined
            ? {}
            : { query_params: { ...request.queryParams } }),
          clickhouse_settings: {
            ...request.settings,
            readonly: "1",
            max_execution_time: Math.max(1, Math.ceil(timeoutMs / 1_000)),
          },
        });
        const rows = await result.json<T>();
        const mapped =
          request.map === undefined
            ? (rows as unknown as readonly Mapped[])
            : rows.map((row, index) => request.map!(row, index));
        const summary = clickHouseSummaryCounts(
          summaryFromHeaders(result.response_headers),
          "query",
        );
        recordClickHouseMetric(this.metrics, {
          operation: "query",
          name,
          queryId: result.query_id,
          attempt,
          rows: summary.rows === 0 ? mapped.length : summary.rows,
          bytes: summary.bytes,
          durationMs: durationMs(startedAt),
          outcome: "success",
        });
        return { queryId: result.query_id, rows: mapped };
      } catch (error) {
        recordClickHouseMetric(this.metrics, {
          operation: "query",
          name,
          queryId: id,
          attempt,
          rows: 0,
          bytes: 0,
          durationMs: durationMs(startedAt),
          outcome: "failure",
          errorClass: clickHouseErrorClass(error),
        });
        if (
          timed.timedOut() ||
          request.signal?.aborted === true ||
          attempt === this.config.safeRetryAttempts ||
          !isTransientClickHouseReadError(error)
        ) {
          throw error;
        }
        await waitBeforeRetry(retryDelayMs(this.config.safeRetryBaseDelayMs, attempt));
      } finally {
        timed.dispose();
      }
    }
    throw new Error("ClickHouse read retry loop ended unexpectedly");
  }

  public async insertRows<T extends Record<string, unknown>>(
    request: ClickHouseInsertRequest<T>,
  ): Promise<ClickHouseInsertResult> {
    const name = assertClickHouseMetricName(request.name);
    const table = `${assertClickHouseIdentifier(this.config.database, "ClickHouse database")}.${assertClickHouseIdentifier(request.table, "ClickHouse table")}`;
    const columns = nonEmptyColumns(request.columns);
    const queryIds: string[] = [];
    let bytes = 0;

    for (let offset = 0; offset < request.rows.length; offset += this.config.insertBatchSize) {
      const batch = request.rows.slice(offset, offset + this.config.insertBatchSize);
      const id = queryId(name, "insert");
      const startedAt = performance.now();
      try {
        const result = await this.client.insert({
          table,
          values: batch,
          format: "JSONEachRow",
          query_id: id,
          ...(columns === undefined ? {} : { columns }),
          ...(request.signal === undefined ? {} : { abort_signal: request.signal }),
          clickhouse_settings: {
            async_insert: this.config.asyncInsert ? 1 : 0,
            wait_for_async_insert: 1,
            wait_for_async_insert_timeout: Math.max(
              1,
              Math.ceil(this.config.requestTimeoutMs / 1_000),
            ),
            ...(this.config.asyncInsert
              ? { async_insert_busy_timeout_max_ms: this.config.insertFlushMs }
              : {}),
          },
        });
        const summary = clickHouseSummaryCounts(result.summary, "insert");
        bytes += summary.bytes;
        queryIds.push(result.query_id);
        recordClickHouseMetric(this.metrics, {
          operation: "insert",
          name,
          queryId: result.query_id,
          attempt: 1,
          rows: summary.rows === 0 ? batch.length : summary.rows,
          bytes: summary.bytes,
          durationMs: durationMs(startedAt),
          outcome: "success",
        });
      } catch (error) {
        recordClickHouseMetric(this.metrics, {
          operation: "insert",
          name,
          queryId: id,
          attempt: 1,
          rows: 0,
          bytes: 0,
          durationMs: durationMs(startedAt),
          outcome: "failure",
          errorClass: clickHouseErrorClass(error),
        });
        // Inserts are never retried here. PG Outbox/Sink idempotency owns replay safety.
        throw error;
      }
    }

    return {
      queryIds,
      batches: queryIds.length,
      rows: request.rows.length,
      bytes,
    };
  }
}

import type { ClickHouseOperationMetric, ClickHouseMetricsSink } from "./types.js";

interface SummaryLike {
  readonly read_rows?: unknown;
  readonly read_bytes?: unknown;
  readonly written_rows?: unknown;
  readonly written_bytes?: unknown;
  readonly result_rows?: unknown;
  readonly result_bytes?: unknown;
}

const METRIC_NAME = /^[a-z][a-z0-9_.-]{0,79}$/u;
const PUBLIC_ERROR_CLASSES = new Set([
  "AbortError",
  "AggregateError",
  "ClickHouseError",
  "ClickHouseConfigurationError",
  "ClickHouseHealthError",
  "ClickHouseMigrationError",
  "ClickHouseMigrationLockError",
  "ClickHouseSinkNotReadyError",
  "Error",
  "NetworkError",
  "TimeoutError",
  "TypeError",
]);
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function safeCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(parsed));
}

export function assertClickHouseMetricName(value: string): string {
  if (!METRIC_NAME.test(value)) {
    throw new Error("ClickHouse metric names must be low-cardinality lowercase identifiers");
  }
  return value;
}

export function clickHouseErrorClass(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = String((error as { readonly code?: unknown }).code);
    if (NETWORK_ERROR_CODES.has(code)) return "NetworkError";
    if (code === "ETIMEDOUT") return "TimeoutError";
  }
  const name = error instanceof Error ? error.name : "UnknownError";
  return PUBLIC_ERROR_CLASSES.has(name) ? name : "ClickHouseError";
}

export function clickHouseSummaryCounts(
  summary: SummaryLike | undefined,
  operation: "query" | "insert",
): { readonly rows: number; readonly bytes: number } {
  if (operation === "insert") {
    return {
      rows: safeCount(summary?.written_rows),
      bytes: safeCount(summary?.written_bytes),
    };
  }
  return {
    rows: safeCount(summary?.result_rows ?? summary?.read_rows),
    bytes: safeCount(summary?.result_bytes ?? summary?.read_bytes),
  };
}

export function summaryFromHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): SummaryLike | undefined {
  const raw = headers["x-clickhouse-summary"] ?? headers["X-ClickHouse-Summary"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? (parsed as SummaryLike) : undefined;
  } catch {
    return undefined;
  }
}

/** Metrics are deliberately best-effort and never include SQL, params, values, or error messages. */
export function recordClickHouseMetric(
  sink: ClickHouseMetricsSink,
  metric: ClickHouseOperationMetric,
): void {
  try {
    void Promise.resolve(sink.record(metric)).catch(() => undefined);
  } catch {
    // Telemetry must never change query/insert behavior.
  }
}

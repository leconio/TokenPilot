interface ErrorShape {
  readonly code?: unknown;
  readonly status?: unknown;
  readonly statusCode?: unknown;
  readonly http_status_code?: unknown;
  readonly name?: unknown;
}

const TRANSIENT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "159",
  "209",
  "210",
]);
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 502, 503, 504]);

function numericStatus(error: ErrorShape): number | undefined {
  for (const value of [error.http_status_code, error.statusCode, error.status]) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) return parsed;
  }
  return undefined;
}

export function isTransientClickHouseReadError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const shape = error as ErrorShape;
  if (shape.name === "AbortError" || shape.name === "TimeoutError") return false;
  if (TRANSIENT_CODES.has(String(shape.code))) return true;
  const status = numericStatus(shape);
  return status !== undefined && TRANSIENT_HTTP_STATUSES.has(status);
}

export function retryDelayMs(baseDelayMs: number, failedAttempt: number): number {
  return Math.min(30_000, baseDelayMs * 2 ** Math.max(0, failedAttempt - 1));
}

export async function waitBeforeRetry(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

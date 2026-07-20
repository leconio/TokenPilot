import type {
  PipelineHealthStatus,
  ReportAiu,
  ReportMoney,
  UsagePageEnvelope,
  UsageReportItem,
} from "@tokenpilot/contracts";

export type ReportRow = Readonly<Record<string, unknown>>;

class UsageReportIdentityError extends TypeError {
  public override readonly name = "UsageReportIdentityError";
}

class UsageReportTimeError extends TypeError {
  public override readonly name = "UsageReportTimeError";
}

class UsageReportLatencyError extends TypeError {
  public override readonly name = "UsageReportLatencyError";
}

class UsageReportTotalError extends TypeError {
  public override readonly name = "UsageReportTotalError";
}

export function reportString(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "bigint" || typeof value === "number") return String(value);
  if (value !== null && typeof value === "object" && "toString" in value) {
    const serialized = String(value);
    return serialized === "" ? null : serialized;
  }
  return null;
}

export function reportCount(value: unknown): number {
  const serialized = reportString(value);
  const parsed = serialized === null ? Number.NaN : Number(serialized);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError("Report count must be a non-negative safe integer");
  }
  return parsed;
}

export function reportInstant(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  const serialized = reportString(value);
  if (serialized === null) return null;
  const explicitUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/u.test(serialized)
    ? `${serialized.replace(" ", "T")}Z`
    : serialized;
  const parsed = new Date(explicitUtc);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function reportMoney(value: unknown, currency: unknown): ReportMoney | null {
  const amount = reportString(value);
  const code = reportString(currency);
  return amount === null || code === null ? null : { value: amount, currency: code };
}

export function reportAiu(value: unknown): ReportAiu | null {
  const micros = reportString(value);
  return micros === null ? null : { micros };
}

export function reportBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  return null;
}

function reportMap(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function reportBooleanMap(value: unknown): Readonly<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  for (const [key, candidate] of Object.entries(reportMap(value))) {
    const normalized = reportBoolean(candidate);
    if (normalized !== null) result[key] = normalized;
  }
  return result;
}

function properties(row: ReportRow, prefix: "event" | "user") {
  return Object.assign(
    {},
    reportMap(row[`${prefix}_text_properties`]),
    reportMap(row[`${prefix}_number_properties`]),
    reportBooleanMap(row[`${prefix}_boolean_properties`]),
    reportMap(row[`${prefix}_datetime_properties`]),
    reportMap(row[`${prefix}_enum_properties`]),
    reportMap(row[`${prefix}_text_list_properties`]),
  );
}

export function usageReportItem(row: ReportRow): UsageReportItem {
  const eventId = reportString(row.event_id);
  const requestId = reportString(row.request_id);
  const attemptId = reportString(row.attempt_id);
  const eventTime = reportInstant(row.event_time);
  const schemaVersion = reportString(row.schema_version);
  const status = reportString(row.status);
  const userId = reportString(row.user_id);
  const modelTag = reportString(row.model_tag);
  if (eventTime === null) {
    throw new UsageReportTimeError("Usage report row has an invalid event time");
  }
  if (
    eventId === null ||
    requestId === null ||
    attemptId === null ||
    schemaVersion === null ||
    status === null ||
    userId === null ||
    modelTag === null
  ) {
    throw new UsageReportIdentityError("Usage report row is missing canonical identity fields");
  }
  let latency: number | null = null;
  if (row.latency_ms !== null && row.latency_ms !== undefined) {
    try {
      latency = reportCount(row.latency_ms);
    } catch {
      throw new UsageReportLatencyError("Usage report row has an invalid latency");
    }
  }
  return {
    event_id: eventId,
    request_id: requestId,
    attempt_id: attemptId,
    operation_id: reportString(row.operation_id),
    event_time: eventTime,
    received_at: reportInstant(row.received_at),
    schema_version: schemaVersion,
    application_version: reportString(row.application_version),
    sdk_version: reportString(row.sdk_version),
    connector_version: reportString(row.connector_version),
    config_version: reportString(row.config_version),
    user_id: userId,
    display_user: reportString(row.display_user),
    session_id: reportString(row.session_id),
    conversation_id: reportString(row.conversation_id),
    trace_id: reportString(row.trace_id),
    virtual_model: reportString(row.virtual_model),
    model_id: reportString(row.model_id),
    model_tag: modelTag,
    provider: reportString(row.provider),
    status,
    route_reason: reportString(row.route_reason),
    fallback_from: reportString(row.fallback_from),
    latency_ms: latency,
    input_tokens: reportString(row.input_tokens) ?? "0",
    cached_input_tokens: reportString(row.cached_input_tokens) ?? "0",
    output_tokens: reportString(row.output_tokens) ?? "0",
    reasoning_output_tokens: reportString(row.reasoning_output_tokens) ?? "0",
    total_tokens: reportString(row.total_tokens) ?? "0",
    provider_cost_status: reportString(row.provider_cost_status),
    provider_cost_amount: reportString(row.provider_cost_amount),
    provider_cost_currency: reportString(row.provider_cost_currency),
    aiu_status: reportString(row.aiu_status),
    aiu_micros: reportString(row.aiu_micros),
    aiu_chargeable: reportBoolean(row.aiu_chargeable),
    quota_status: reportString(row.quota_status),
    event_properties: properties(row, "event"),
    user_properties: properties(row, "user"),
  };
}

export function usagePageEnvelope<T>(
  items: readonly T[],
  pageSize: number,
  total: unknown,
  nextCursor: string | null,
): UsagePageEnvelope<T> {
  let normalizedTotal: number;
  try {
    normalizedTotal = reportCount(total);
  } catch {
    throw new UsageReportTotalError("Usage report total is invalid");
  }
  return {
    items,
    page_size: pageSize,
    total: normalizedTotal,
    next_cursor: nextCursor,
  };
}

const healthStatuses = new Set<PipelineHealthStatus>([
  "healthy",
  "degraded",
  "stale",
  "unavailable",
  "unknown",
]);

export function reportHealth(value: unknown): PipelineHealthStatus {
  const normalized = reportString(value)?.toLowerCase();
  return normalized !== undefined &&
    normalized !== null &&
    healthStatuses.has(normalized as PipelineHealthStatus)
    ? (normalized as PipelineHealthStatus)
    : "unknown";
}

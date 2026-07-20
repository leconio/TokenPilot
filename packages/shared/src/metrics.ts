export type OperationalMetricKind = "counter" | "gauge" | "histogram";

export interface OperationalMetricContract {
  readonly name: `ai_control_${string}`;
  readonly kind: OperationalMetricKind;
  readonly labels: readonly string[];
}

const contract = (
  name: OperationalMetricContract["name"],
  kind: OperationalMetricKind,
  labels: readonly string[] = [],
): OperationalMetricContract => ({ name, kind, labels });

export const OPERATIONAL_METRICS = Object.freeze({
  ingestionEvents: contract("ai_control_ingestion_events_total", "counter"),
  ingestionBatches: contract("ai_control_ingestion_batches_total", "counter"),
  ingestionRejected: contract("ai_control_ingestion_rejected_total", "counter"),
  ingestionDuplicates: contract("ai_control_ingestion_duplicates_total", "counter"),
  ingestionPayloadConflicts: contract("ai_control_ingestion_payload_conflicts_total", "counter"),
  ingestionLatency: contract("ai_control_ingestion_latency_seconds", "histogram"),
  inboxPending: contract("ai_control_inbox_pending_total", "gauge"),
  inboxOldestAge: contract("ai_control_inbox_oldest_age_seconds", "gauge"),
  settlementEvents: contract("ai_control_settlement_events_total", "counter", ["stage", "status"]),
  settlementLatency: contract("ai_control_settlement_latency_seconds", "histogram"),
  settlementRetry: contract("ai_control_settlement_retry_total", "counter"),
  settlementDlq: contract("ai_control_settlement_dlq_total", "counter"),
  providerCostUnpriced: contract("ai_control_provider_cost_unpriced_total", "counter"),
  aiuUnrated: contract("ai_control_aiu_unrated_total", "counter"),
  modelUnmapped: contract("ai_control_model_unmapped_total", "counter"),
  clickhouseHealth: contract("ai_control_clickhouse_health", "gauge"),
  clickhouseInsertRows: contract("ai_control_clickhouse_insert_rows_total", "counter"),
  clickhouseInsertBytes: contract("ai_control_clickhouse_insert_bytes_total", "counter"),
  clickhouseInsertLatency: contract("ai_control_clickhouse_insert_latency_seconds", "histogram"),
  clickhouseInsertFailures: contract("ai_control_clickhouse_insert_failures_total", "counter"),
  clickhouseQueryLatency: contract("ai_control_clickhouse_query_latency_seconds", "histogram"),
  clickhouseQueryFailures: contract("ai_control_clickhouse_query_failures_total", "counter"),
  clickhouseOutboxBacklog: contract("ai_control_clickhouse_outbox_backlog", "gauge"),
  clickhouseSinkLag: contract("ai_control_clickhouse_sink_lag_seconds", "gauge"),
  clickhouseRawWatermark: contract("ai_control_clickhouse_raw_watermark_seconds", "gauge"),
  clickhouseOfficialWatermark: contract(
    "ai_control_clickhouse_official_watermark_seconds",
    "gauge",
  ),
  clickhouseStorageUtilization: contract(
    "ai_control_clickhouse_storage_utilization_ratio",
    "gauge",
  ),
  aiuRatedMicros: contract("ai_control_aiu_rated_micros_total", "counter"),
  aiuConsumedMicros: contract("ai_control_aiu_consumed_micros_total", "counter"),
  aiuAdjustedMicros: contract("ai_control_aiu_adjusted_micros_total", "counter"),
  quotaCheck: contract("ai_control_quota_check_total", "counter", ["decision"]),
  quotaReservationsActive: contract("ai_control_quota_reservations_active", "gauge"),
  quotaReservationExpired: contract("ai_control_quota_reservation_expired_total", "counter"),
  quotaNegativeBalanceUsers: contract("ai_control_quota_negative_balance_users", "gauge"),
  reconciliationRuns: contract("ai_control_reconciliation_runs_total", "counter", [
    "run_type",
    "status",
  ]),
  reconciliationDiff: contract("ai_control_reconciliation_diff_total", "counter", [
    "diff_type",
    "severity",
  ]),
  reconciliationCostDelta: contract("ai_control_reconciliation_cost_delta", "gauge"),
  reconciliationAiuMicroDelta: contract("ai_control_reconciliation_aiu_micro_delta", "gauge"),
  reconciliationLastSuccess: contract("ai_control_reconciliation_last_success_timestamp", "gauge"),
});

const FORBIDDEN_LABELS = new Set([
  "subject_id",
  "request_id",
  "event_id",
  "attempt_id",
  "operation_id",
  "trace_id",
]);

export function assertOperationalMetricContracts(
  metrics: Readonly<Record<string, OperationalMetricContract>> = OPERATIONAL_METRICS,
): void {
  const names = new Set<string>();
  for (const metric of Object.values(metrics)) {
    if (names.has(metric.name)) throw new TypeError(`duplicate metric name: ${metric.name}`);
    names.add(metric.name);
    for (const label of metric.labels) {
      if (!/^[a-z][a-z0-9_]*$/u.test(label) || FORBIDDEN_LABELS.has(label)) {
        throw new TypeError(`unsafe metric label: ${metric.name}{${label}}`);
      }
    }
  }
}

const SECRET_KEY =
  /(?:api[_-]?key|authorization|bearer|credential|password|private[_-]?key|secret|signature|token)$/iu;
const CONTENT_KEY = /(?:prompt|response|completion|message|body|dimension[_-]?values?)$/iu;
const SUBJECT_KEY = /(?:^|[_-])subject[_-]?id$/iu;

/** Keeps operational context while preventing credentials, content, and raw subjects from entering logs. */
export function sanitizeOperationalAttributes(
  value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  if (value === undefined) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (SUBJECT_KEY.test(key)) return [];
      if (SECRET_KEY.test(key)) return [[key, "[REDACTED]"]];
      if (CONTENT_KEY.test(key)) return [[key, "[OMITTED]"]];
      if (Array.isArray(item)) return [[key, `[array:${item.length}]`]];
      if (item !== null && typeof item === "object") return [[key, "[OBJECT]"]];
      return [[key, typeof item === "string" ? item.slice(0, 512) : item]];
    }),
  );
}

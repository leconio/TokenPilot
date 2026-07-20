import type { ReportGroupDimension, ReportMetric } from "./report-query.js";

export interface UsagePageEnvelope<T> {
  readonly items: readonly T[];
  readonly page_size: number;
  readonly total: number;
  readonly next_cursor: string | null;
}

export interface ReportMoney {
  readonly value: string;
  readonly currency: string;
}

export interface ReportAiu {
  readonly micros: string;
}

export interface UsageReportItem {
  readonly event_id: string;
  readonly request_id: string;
  readonly attempt_id: string;
  readonly operation_id: string | null;
  readonly event_time: string;
  readonly received_at: string | null;
  readonly schema_version: string;
  readonly application_version: string | null;
  readonly sdk_version: string | null;
  readonly connector_version: string | null;
  readonly config_version: string | null;
  readonly user_id: string;
  readonly display_user: string | null;
  readonly session_id: string | null;
  readonly conversation_id: string | null;
  readonly trace_id: string | null;
  readonly virtual_model: string | null;
  readonly model_id: string | null;
  readonly model_tag: string;
  readonly provider: string | null;
  readonly status: string;
  readonly route_reason: string | null;
  readonly fallback_from: string | null;
  readonly latency_ms: number | null;
  readonly input_tokens: string;
  readonly cached_input_tokens: string;
  readonly output_tokens: string;
  readonly reasoning_output_tokens: string;
  readonly total_tokens: string;
  readonly provider_cost_status: string | null;
  readonly provider_cost_amount: string | null;
  readonly provider_cost_currency: string | null;
  readonly aiu_status: string | null;
  readonly aiu_micros: string | null;
  readonly aiu_chargeable: boolean | null;
  readonly quota_status: string | null;
  readonly event_properties: Readonly<Record<string, unknown>>;
  readonly user_properties: Readonly<Record<string, unknown>>;
}

export interface OverviewReportData {
  readonly provider_cost: ReportMoney | null;
  readonly provider_costs: readonly ReportMoney[];
  readonly requests: number;
  readonly total_tokens: string;
  readonly attempts: number;
  readonly success: number;
  readonly errors: number;
  readonly unpriced_events: number;
  readonly unmapped_events: number;
  readonly aiu: ReportAiu | null;
  readonly settlement_lag_seconds: number | null;
  readonly reconciliation_status: string | null;
  readonly last_usage_received_at: string | null;
  readonly request_trend: readonly {
    readonly bucket: string;
    readonly requests: number;
  }[];
}

export type ActivityMetricUnit = "calls" | "tokens" | "users" | "percent" | "milliseconds";

export interface ActivityMetricPoint {
  readonly key: string;
  readonly value: string | null;
}

export interface ActivityReportData {
  readonly metric: Exclude<ReportMetric, "provider_cost" | "aiu">;
  readonly unit: ActivityMetricUnit;
  readonly total: string | null;
  readonly group_dimension: ReportGroupDimension;
  readonly groups: readonly ActivityMetricPoint[];
  readonly trend: readonly ActivityMetricPoint[];
  readonly page_size: number;
  readonly total_groups: number;
  readonly next_cursor: string | null;
}

export interface ProviderCostGroup {
  readonly dimension: ReportGroupDimension;
  readonly key: string;
  readonly currency: string;
  readonly amount: string;
}

export interface ProviderCostReportData {
  readonly total: ReportMoney | null;
  readonly totals: readonly ReportMoney[];
  readonly source_cost: ReportMoney | null;
  readonly cache_savings: ReportMoney | null;
  readonly failed_attempt_cost: ReportMoney | null;
  readonly fallback_extra_cost: ReportMoney | null;
  readonly unpriced_events: number;
  readonly group_dimension: ReportGroupDimension;
  readonly groups: readonly ProviderCostGroup[];
  readonly page_size: number;
  readonly total_groups: number;
  readonly next_cursor: string | null;
}

export interface AiuGroup {
  readonly dimension: ReportGroupDimension;
  readonly key: string;
  readonly aiu_micros: string;
}

export interface AiuReportData {
  readonly total: ReportAiu | null;
  readonly unrated_events: number;
  readonly unmapped_events: number;
  readonly group_dimension: ReportGroupDimension;
  readonly groups: readonly AiuGroup[];
  readonly page_size: number;
  readonly total_groups: number;
  readonly next_cursor: string | null;
}

export type PipelineHealthStatus = "healthy" | "degraded" | "stale" | "unavailable" | "unknown";

export interface PipelineHealthReportData {
  readonly connector: PipelineHealthStatus;
  readonly postgres: PipelineHealthStatus;
  readonly redis: PipelineHealthStatus;
  readonly clickhouse: PipelineHealthStatus;
  readonly settlement: PipelineHealthStatus;
  readonly reconciliation: PipelineHealthStatus;
  readonly event_count: number | null;
  readonly last_event_at: string | null;
  readonly last_inserted_at: string | null;
  readonly stages: readonly Readonly<Record<string, unknown>>[];
  readonly inbox: readonly Readonly<Record<string, unknown>>[];
  readonly outbox: readonly Readonly<Record<string, unknown>>[];
  readonly sync: readonly Readonly<Record<string, unknown>>[];
}

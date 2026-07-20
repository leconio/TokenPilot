export type DecimalString = string;
export type AiuMicrosString = string;

export interface ReportEnvelope<T> {
  readonly watermark: string | null;
  readonly lag_seconds: number | null;
  readonly range: {
    readonly from: string;
    readonly to: string;
    readonly timezone: string;
  } | null;
  readonly data: T;
}

export interface PageEnvelope<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
  readonly next_cursor?: string | null;
}

export interface CursorPageEnvelope<T> {
  readonly items: readonly T[];
  readonly page_size: number;
  readonly total: number;
  readonly next_cursor: string | null;
}

export interface InstanceCapabilities {
  readonly capabilities?: readonly string[];
  readonly feature_flags?: Readonly<Record<string, boolean>>;
  readonly permissions?: readonly string[];
  readonly role?: "owner" | "admin" | "finance" | "developer" | "support" | "viewer";
}

export interface MetricValue {
  readonly value: DecimalString;
  readonly currency?: string;
  readonly display?: string;
  readonly unit?: string;
}

export interface OverviewReport {
  readonly provider_cost?: MetricValue;
  readonly source_cost?: MetricValue;
  readonly requests?: number;
  readonly total_tokens?: DecimalString;
  readonly attempts?: number;
  readonly success?: number;
  readonly errors?: number;
  readonly unpriced_events?: number;
  readonly unmapped_events?: number;
  readonly fallback_extra_cost?: MetricValue;
  readonly failed_attempt_cost?: MetricValue;
  readonly aiu?: { micros: AiuMicrosString; display?: string };
  readonly settlement_lag_seconds?: number;
  readonly reconciliation_status?: string;
  readonly last_usage_received_at?: string;
  readonly request_trend?: readonly { readonly bucket: string; readonly requests: number }[];
}

export interface ApplicationUserSummary {
  readonly total_users: number;
  readonly blocked_users: number;
  readonly limit_aiu_micros: AiuMicrosString;
  readonly used_aiu_micros: AiuMicrosString;
  readonly reserved_aiu_micros: AiuMicrosString;
  readonly remaining_aiu_micros: AiuMicrosString;
}

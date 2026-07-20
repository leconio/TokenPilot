export interface UsageRow {
  readonly event_id: string;
  readonly request_id: string;
  readonly attempt_id: string;
  readonly attempt_index: number;
  readonly is_final_attempt: boolean;
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
  readonly connection_id: string | null;
  readonly connection_driver: string | null;
  readonly request_model: string;
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
  readonly quota_status: string | null;
  readonly event_properties: Readonly<Record<string, unknown>>;
  readonly user_properties: Readonly<Record<string, unknown>>;
}

export function usageCost(row: UsageRow): string {
  if (!row.provider_cost_amount || !row.provider_cost_currency) return "-";
  return `${row.provider_cost_currency} ${row.provider_cost_amount}`;
}

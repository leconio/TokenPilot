export interface UserQuota {
  readonly limit_aiu_micros: string;
  readonly used_aiu_micros: string;
  readonly reserved_aiu_micros: string;
  readonly remaining_aiu_micros: string;
  readonly hard_limit: boolean;
  readonly period: string;
  readonly period_start: string | null;
  readonly period_end: string | null;
}

export type AiuQuotaPeriod = "day" | "week" | "month" | "fixed" | "lifetime";

export interface AiuQuotaPolicy {
  readonly id: string;
  readonly scope: "application" | "user_group" | "user";
  readonly user_id: string | null;
  readonly user_group_id: string | null;
  readonly subject_name: string | null;
  readonly limit_aiu_micros: string;
  readonly hard_limit: boolean;
  readonly period: AiuQuotaPeriod;
  readonly starts_at: string | null;
  readonly ends_at: string | null;
  readonly priority: number;
  readonly enabled: boolean;
  readonly updated_at: string;
}

export interface AiuQuotaPolicyList {
  readonly policies: readonly AiuQuotaPolicy[];
}

export interface AiuQuotaPolicyInput {
  readonly limit: string;
  readonly hard_limit: boolean;
  readonly period: AiuQuotaPeriod;
  readonly starts_at?: string;
  readonly ends_at?: string;
  readonly priority: number;
}

export interface ApplicationUser {
  readonly id: string;
  readonly user_id: string;
  readonly display_user: string | null;
  readonly tags: readonly string[];
  readonly properties: unknown;
  readonly status: "active" | "blocked";
  readonly blocked_reason: string | null;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly usage: {
    readonly calls: number;
    readonly tokens: string;
    readonly aiu_micros: string;
  };
  readonly quota: UserQuota;
}

export interface UserList {
  readonly users: readonly ApplicationUser[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
}

export interface UserLedgerEntry {
  readonly id: string;
  readonly type: string;
  readonly used_change_aiu_micros: string;
  readonly reserved_change_aiu_micros: string;
  readonly reason: string | null;
  readonly created_at: string;
}

export interface UserAnalytics {
  readonly range: { readonly from: string; readonly to: string };
  readonly trend: readonly {
    readonly bucket: string;
    readonly calls: number;
    readonly tokens: string;
    readonly aiu_micros: string;
  }[];
  readonly models: readonly {
    readonly request_model: string;
    readonly virtual_model: string;
    readonly calls: number;
    readonly tokens: string;
    readonly aiu_micros: string;
    readonly costs: readonly { readonly currency: string; readonly amount: string }[];
  }[];
  readonly costs: readonly { readonly currency: string; readonly amount: string }[];
  readonly recent_calls: readonly {
    readonly event_id: string;
    readonly request_id: string;
    readonly event_time: string;
    readonly virtual_model: string;
    readonly request_model: string;
    readonly status: string;
  }[];
  readonly operations: readonly {
    readonly id: string;
    readonly action: string;
    readonly actor: string;
    readonly reason: string | null;
    readonly created_at: string;
  }[];
}

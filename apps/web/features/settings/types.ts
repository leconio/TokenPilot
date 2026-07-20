export interface SettingsResponse {
  readonly app_name?: string;
  readonly instance_id: string;
  readonly environment?: string;
  readonly timezone: string;
  readonly base_currency: string;
  readonly version?: string;
  readonly build_sha?: string;
  readonly raw_event_retention_days?: number;
  readonly retention_days?: number;
  readonly privacy: Record<string, boolean>;
  readonly feature_flags: Record<string, boolean>;
  readonly service_key_count?: number;
  readonly active_web_sessions?: number;
}
export interface ServiceApiKey {
  readonly id: string;
  readonly name: string;
  readonly keyPrefix?: string;
  readonly key_prefix?: string;
  readonly scopes: readonly string[];
  readonly status: string;
  readonly lastUsedAt?: string | null;
  readonly last_used_at?: string | null;
  readonly expiresAt?: string | null;
  readonly expires_at?: string | null;
  readonly createdAt?: string;
}
export interface IssuedKey {
  readonly id: string;
  readonly key_prefix: string;
  readonly api_key: string;
}

export type ApplicationRoleName = "owner" | "admin" | "analyst" | "viewer";

export interface ManagedApplication {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: "active" | "disabled";
  readonly timezone: string;
  readonly base_currency: string;
  readonly archived_at: string | null;
  readonly role: ApplicationRoleName;
  readonly permissions: readonly string[];
  readonly member_count?: number;
}

export interface ApplicationMember {
  readonly user_id: string;
  readonly name: string;
  readonly email: string;
  readonly role: ApplicationRoleName;
  readonly permissions: readonly string[];
  readonly created_at: string;
}

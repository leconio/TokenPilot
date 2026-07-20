export type UserGroupMatch = "all" | "any";
export type UserGroupField =
  | "user_id"
  | "display_user"
  | "tag"
  | "status"
  | "property"
  | "last_seen_at"
  | "calls"
  | "tokens"
  | "aiu"
  | "cost"
  | "remaining_aiu";

export interface UserGroupCondition {
  readonly field: UserGroupField;
  readonly operator: string;
  readonly property?: string;
  readonly value?: string;
}

export interface UserGroupDefinition {
  readonly match: UserGroupMatch;
  readonly conditions: readonly UserGroupCondition[];
}

export interface ApplicationUserGroup {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly definition: UserGroupDefinition;
  readonly definition_version: number;
  readonly refresh_minutes: number | null;
  readonly enabled: boolean;
  readonly member_count: number;
  readonly latest_evaluation_id: string | null;
  readonly evaluated_at: string | null;
  readonly updated_at: string;
}

export interface UserGroupMember {
  readonly id: string;
  readonly user_id: string;
  readonly display_user: string | null;
  readonly status: "active" | "blocked";
  readonly last_seen_at: string;
}

export interface UserGroupPreview {
  readonly member_count: number;
  readonly sample_users: readonly {
    readonly id: string;
    readonly user_id: string;
    readonly display_user: string | null;
    readonly tags: readonly string[];
    readonly status: string;
    readonly calls: number;
    readonly tokens: string;
    readonly aiu_micros: string;
  }[];
}

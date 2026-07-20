export interface ModelItem {
  readonly id: string;
  readonly name: string;
  readonly litellm_tag: string;
  readonly enabled: boolean;
}

export interface VirtualModelTarget {
  readonly id: string;
  readonly model: ModelItem;
  readonly priority: number;
  readonly weight: string;
  readonly enabled: boolean;
}

export interface VirtualModelRule {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly match:
    | {
        readonly schedule: {
          readonly days: readonly number[];
          readonly from: string;
          readonly to: string;
        };
      }
    | { readonly override_active: true }
    | { readonly user: { readonly ids: readonly string[] } }
    | { readonly user_group: { readonly group_id: string } }
    | { readonly user_tag: { readonly value: string } }
    | {
        readonly user_property: {
          readonly key: string;
          readonly operator: string;
          readonly value?: string | number | boolean;
        };
      }
    | { readonly aiu_state: { readonly value: string } }
    | { readonly call_source: { readonly value: string } };
  readonly target_model: ModelItem;
  readonly expires_at: string | null;
  readonly enabled: boolean;
}

export interface VirtualModelItem {
  readonly id: string;
  readonly name: string;
  readonly display_name: string;
  readonly enabled: boolean;
  readonly default_model: ModelItem | null;
  readonly targets: readonly VirtualModelTarget[];
  readonly rules: readonly VirtualModelRule[];
  readonly last_published_version: number | null;
}

export interface SimulationResult {
  readonly matched_rule: string | null;
  readonly reason: "default" | "condition";
  readonly selection_mode: "ordered" | "weighted";
  readonly timezone: string;
  readonly model: ModelItem;
  readonly fallbacks: readonly string[];
}

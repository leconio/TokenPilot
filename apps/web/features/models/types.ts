export interface ModelDefinition {
  readonly id: string;
  readonly name: string;
  readonly request_model: string;
  readonly provider: string | null;
  readonly task_type?: "chat" | "embedding" | "image" | "audio";
  readonly capabilities?: readonly string[];
  readonly connection?: {
    readonly id: string;
    readonly name: string;
    readonly driver: string;
    readonly enabled: boolean;
    readonly status: string;
  };
  readonly enabled: boolean;
  readonly metrics?: ModelMetrics | undefined;
  readonly virtual_model_references?: readonly VirtualModelReference[] | undefined;
  readonly recent_issues?: readonly ModelIssue[] | undefined;
}

export interface ModelMetrics {
  readonly calls: number;
  readonly tokens: string;
  readonly cost: string;
  readonly currency: string;
  readonly aiu: string;
  readonly aiu_micros: string;
}

export interface VirtualModelReference {
  readonly id: string;
  readonly name: string;
  readonly display_name: string;
  readonly enabled: boolean;
  readonly uses_as: readonly ("default" | "candidate" | "rule")[];
}

export interface ModelIssue {
  readonly event_id: string;
  readonly occurred_at: string;
  readonly types: readonly ("unresolved" | "unpriced" | "unrated")[];
  readonly detail: string | null;
}

export interface ModelDisableImpact {
  readonly model: Pick<ModelDefinition, "id" | "name" | "request_model">;
  readonly virtual_models: readonly VirtualModelReference[];
  readonly reference_count: number;
  readonly affects_routing: boolean;
}

export interface ModelRates {
  readonly model: Pick<ModelDefinition, "id" | "name" | "request_model">;
  readonly cost_currency: string;
  readonly cost: {
    readonly version: number;
    readonly currency: string;
    readonly effective_from: string;
    readonly source_priority: "reported_first";
    readonly rules: readonly ModelCostRule[];
  } | null;
  readonly aiu: {
    readonly version: number;
    readonly effective_from: string;
    readonly rates: RateValues;
  } | null;
}

export interface RateValues {
  readonly input_per_million?: string | null;
  readonly cache_read_per_million?: string | null;
  readonly cache_write_per_million?: string | null;
  readonly output_per_million?: string | null;
  readonly reasoning_per_million?: string | null;
  readonly input_image?: string | null;
  readonly output_image?: string | null;
  readonly input_audio_second?: string | null;
  readonly output_audio_second?: string | null;
  readonly input_video_second?: string | null;
  readonly output_video_second?: string | null;
  readonly embedding_per_million?: string | null;
  readonly unknown_unit?: string | null;
  readonly custom_units?: readonly CustomRate[];
}

export interface CustomRate {
  readonly unit_key: string;
  readonly unit_size: string;
  readonly rate: string;
}

export type RateField = Exclude<keyof RateValues, "custom_units">;
export type EditableRates = Record<RateField, string> & { custom_units: CustomRate[] };

export type CostConditionValue = string | number | boolean;

export type ModelCostCondition =
  | Readonly<{
      kind: "builtin";
      field: string;
      operator: string;
      values: readonly CostConditionValue[];
    }>
  | Readonly<{
      kind: "property";
      scope: "event" | "user";
      key: string;
      data_type?: string;
      operator: string;
      values: readonly CostConditionValue[];
    }>;

export interface ModelCostUsageAmount {
  readonly usage_type: string;
  readonly unit_key?: string;
  readonly amount_per_unit: string;
}

export interface ModelCostRule {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly match: "all" | "any";
  readonly conditions: readonly ModelCostCondition[];
  readonly fixed_amount: string | null;
  readonly rates: readonly ModelCostUsageAmount[];
}

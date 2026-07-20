export type ConnectionDriver = "litellm" | "openai_compatible" | "anthropic";

export const connectionDriverLabels: Readonly<Record<ConnectionDriver, string>> = {
  litellm: "LiteLLM",
  openai_compatible: "OpenAI 兼容服务",
  anthropic: "Anthropic",
};

export interface CallConnection {
  readonly id: string;
  readonly name: string;
  readonly driver: ConnectionDriver;
  readonly base_url: string | null;
  readonly credential_ref: string | null;
  readonly public_config: Readonly<Record<string, unknown>>;
  readonly enabled: boolean;
  readonly status: "unverified" | "available" | "degraded" | "offline";
  readonly last_seen_at: string | null;
  readonly connector_instance: {
    readonly id: string;
    readonly instance_id: string;
    readonly name: string;
    readonly status: string;
  } | null;
  readonly model_count: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ConnectorOption {
  readonly id: string;
  readonly instance_id: string;
  readonly name: string;
  readonly status: string;
}

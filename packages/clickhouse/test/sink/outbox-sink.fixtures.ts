import type { ClickHouseOutboxRecord } from "../../src/index.js";

export function record(id: bigint, eventType: string, payload: unknown): ClickHouseOutboxRecord {
  return {
    id,
    aggregateType: "test",
    aggregateId: `aggregate-${id.toString()}`,
    eventType,
    payload:
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? {
            application_id: "00000000-0000-4000-8000-000000000001",
            property_types: propertyTypes,
            ...payload,
          }
        : payload,
    idempotencyKey: `event-${id.toString()}`,
    replayOfOutboxId: null,
    createdAt: new Date("2026-07-16T01:00:00.000Z"),
  };
}

export const propertyTypes = {
  event: { next_action: "TEXT", voice_enabled: "BOOLEAN" },
  user: { member_level: "ENUM", interests: "TEXT_LIST" },
};

export const normalized = {
  schema_version: "2.0",
  event_id: "123e4567-e89b-42d3-a456-426614174000",
  event_time: "2026-07-16T00:00:00.000Z",
  application_version: "2026.7.18",
  sdk_version: "0.2.0",
  connector_version: "0.2.0",
  config_version: "42",
  user: { user_id: "user-1", display_user: "Ada" },
  event_properties: { next_action: "summarize", voice_enabled: true },
  user_properties: { member_level: "VVIP", interests: ["AI", "voice"] },
  source: { type: "gateway", name: "gateway", version: "2", instance_id: "gw-1" },
  request: {
    request_id: "request-1",
    attempt_id: "attempt-1",
    operation_id: "operation-1",
    parent_request_id: null,
    session_id: null,
    conversation_id: "conversation-1",
    trace_id: null,
  },
  model: {
    virtual_model: "assistant",
    model_id: "base-model-1",
    model_tag: "provider/model",
    provider: "provider",
  },
  route: {
    configuration_version: "1",
    rule: "default",
    reason: "primary",
    tags: [],
    fallback_from: null,
    is_final_success_attempt: true,
    is_user_visible_operation: true,
  },
  analytics_dimensions: { region: "cn" },
  result: { status: "success", http_status: 200, latency_ms: 42, error_class: null },
  source_cost: null,
  privacy: { contains_prompt: false, contains_response: false },
  normalization: {
    normalizer_name: "native",
    normalizer_version: "1",
    missing_usage_fields: [],
    warnings: [],
  },
  usage_lines: [
    {
      usage_type: "uncached_input_token",
      quantity: "12",
      unit: "token",
      source_path: "usage.uncached_input_tokens",
      is_estimated: false,
      confidence: "exact",
    },
  ],
};

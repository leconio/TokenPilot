import { describe, expect, it } from "vitest";

import { normalizeUsageEvent } from "../../src/pipeline/normalization.js";

describe("normalizeUsageEvent", () => {
  it("maps raw buckets to one mutually exclusive normalized line each", () => {
    const event = {
      schema_version: "2.0",
      event_id: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
      event_time: "2026-07-16T08:00:00Z",
      user: { user_id: "normalization-user", display_user: "Normalization user" },
      source: { type: "gateway", name: "gateway", version: "1", instance_id: "gw-1" },
      request: {
        request_id: "request-1",
        attempt_id: "attempt-1",
        attempt_index: 0,
        is_final_attempt: true,
        operation_id: null,
        parent_request_id: null,
        session_id: null,
        conversation_id: null,
        trace_id: null,
      },
      model: {
        request_model: "provider/model",
        provider: "provider",
      },
      route: null,
      analytics_dimensions: {},
      result: { status: "success", http_status: 200, latency_ms: 1, error_class: null },
      source_cost: null,
      privacy: { contains_prompt: false, contains_response: false },
      usage: {
        uncached_input_tokens: "10",
        cache_read_input_tokens: "4",
        output_tokens: "2",
        custom_units: [
          {
            unit_key: "tool_call",
            quantity: "1",
            unit: "call",
            source_path: "usage.tool_calls",
            is_estimated: true,
          },
        ],
      },
    };
    const normalized = normalizeUsageEvent(event);

    expect(normalized.usage_lines).toEqual([
      expect.objectContaining({
        usage_type: "uncached_input_token",
        quantity: "10",
        unit: "token",
      }),
      expect.objectContaining({
        usage_type: "cache_read_input_token",
        quantity: "4",
        unit: "token",
      }),
      expect.objectContaining({ usage_type: "output_token", quantity: "2", unit: "token" }),
      expect.objectContaining({
        usage_type: "custom_unit",
        unit_key: "tool_call",
        quantity: "1",
        unit: "custom",
        confidence: "estimated",
      }),
    ]);
    const reconciled = normalizeUsageEvent({
      ...event,
      source: { ...event.source, type: "reconciler" },
    });
    expect(
      reconciled.usage_lines.every((line) => line.confidence === "estimated" && line.is_estimated),
    ).toBe(true);
  });
});

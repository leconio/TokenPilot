import { readFile } from "node:fs/promises";

import { Decimal } from "decimal.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { usageEventSchema, type UsageEvent } from "@tokenpilot/contracts";

import { providerPromptCacheMetrics } from "../src/cache-metrics.js";
import { NormalizationError } from "../src/errors.js";
import {
  LiteLLMStandardLoggingAdapter,
  standardUsageFieldValues,
} from "../src/litellm-standard-logging-adapter.js";
import { normalizeWithAdapters } from "../src/registry.js";

type ProviderUsageField =
  | "input_tokens"
  | "output_tokens"
  | "cache_read_input_tokens"
  | "cache_write_input_tokens"
  | "reasoning_output_tokens"
  | "input_images"
  | "output_images"
  | "audio_input_seconds"
  | "audio_output_seconds";

interface ScenarioRoute {
  readonly configuration_version: number | null;
  readonly rule_id: string | null;
  readonly route_tag: string | null;
  readonly reason: string | null;
  readonly fallback_from: string | null;
}

interface ScenarioEvent {
  readonly provider: string;
  readonly actual_model: string;
  readonly deployment_id?: string;
  readonly attempt_id?: string;
  readonly status?: "success" | "failure";
  readonly http_status?: number;
  readonly error_code?: string;
  readonly usage?: Partial<Record<ProviderUsageField, number>>;
  readonly confidence?: string;
  readonly present_fields: readonly ProviderUsageField[];
  readonly input_token_semantics?: "total_including_cache" | "uncached_only";
  readonly output_token_semantics?: "total_including_reasoning" | "reasoning_excluded";
  readonly attempt_visibility?: "complete" | "incomplete";
  readonly gateway_response_cache_hit?: boolean | null;
  readonly source_fields?: Readonly<Record<string, readonly string[]>>;
  readonly route?: ScenarioRoute;
  readonly expected_error?: string;
}

interface Scenario {
  readonly name: string;
  readonly events: readonly ScenarioEvent[];
}

const eventIds = [
  "01ARZ3NDEKTSV4RRFFQ69G5FA0",
  "01ARZ3NDEKTSV4RRFFQ69G5FA1",
  "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  "01ARZ3NDEKTSV4RRFFQ69G5FA3",
  "01ARZ3NDEKTSV4RRFFQ69G5FA4",
  "01ARZ3NDEKTSV4RRFFQ69G5FA5",
  "01ARZ3NDEKTSV4RRFFQ69G5FA6",
  "01ARZ3NDEKTSV4RRFFQ69G5FA7",
  "01ARZ3NDEKTSV4RRFFQ69G5FA8",
  "01ARZ3NDEKTSV4RRFFQ69G5FA9",
  "01ARZ3NDEKTSV4RRFFQ69G5FAA",
  "01ARZ3NDEKTSV4RRFFQ69G5FAB",
  "01ARZ3NDEKTSV4RRFFQ69G5FAC",
  "01ARZ3NDEKTSV4RRFFQ69G5FAD",
] as const;

function decimal(value: number): string {
  return new Decimal(value).toFixed();
}

function providerQuantity(event: ScenarioEvent, field: ProviderUsageField): number {
  return event.usage?.[field] ?? 0;
}

function canonicalUsage(event: ScenarioEvent): Readonly<Record<string, string>> {
  const present = new Set(event.present_fields);
  const cacheRead = providerQuantity(event, "cache_read_input_tokens");
  const cacheWrite = providerQuantity(event, "cache_write_input_tokens");
  const input = providerQuantity(event, "input_tokens");
  const reasoning = providerQuantity(event, "reasoning_output_tokens");
  const output = providerQuantity(event, "output_tokens");
  const values: Record<string, string> = { request_count: "1" };
  if (present.has("input_tokens")) {
    values.uncached_input_tokens = decimal(
      event.input_token_semantics === "uncached_only" ? input : input - cacheRead - cacheWrite,
    );
  }
  if (present.has("cache_read_input_tokens")) {
    values.cache_read_input_tokens = decimal(cacheRead);
  }
  if (present.has("cache_write_input_tokens")) {
    values.cache_write_input_tokens = decimal(cacheWrite);
  }
  if (present.has("output_tokens")) {
    values.output_tokens = decimal(
      event.output_token_semantics === "reasoning_excluded" ? output : output - reasoning,
    );
  }
  if (present.has("reasoning_output_tokens")) {
    values.reasoning_output_tokens = decimal(reasoning);
  }
  if (present.has("input_images")) {
    values.input_images = decimal(providerQuantity(event, "input_images"));
  }
  if (present.has("output_images")) {
    values.output_images = decimal(providerQuantity(event, "output_images"));
  }
  if (present.has("audio_input_seconds")) {
    values.input_audio_seconds = decimal(providerQuantity(event, "audio_input_seconds"));
  }
  if (present.has("audio_output_seconds")) {
    values.output_audio_seconds = decimal(providerQuantity(event, "audio_output_seconds"));
  }
  return values;
}

function eventFromScenario(scenario: Scenario, event: ScenarioEvent, index: number): unknown {
  const route = event.route;
  return {
    schema_version: "2.0",
    event_id: eventIds[index],
    event_time: "2026-07-15T08:00:00.000Z",
    user: { user_id: "user-fixture", display_user: "Fixture user" },
    source: {
      type: "gateway",
      name: "litellm",
      version: "1.80.0",
      instance_id: "litellm-fixture-01",
    },
    request: {
      request_id: `request-${scenario.name}`,
      attempt_id: event.attempt_id ?? `attempt-${index}`,
      operation_id: null,
      parent_request_id: "business-request-fixture",
      session_id: "session-fixture",
      conversation_id: "conversation-fixture",
      trace_id: "trace-fixture",
    },
    model: {
      virtual_model: "text.fast",
      model_tag: event.deployment_id ?? event.actual_model,
      provider: event.provider,
    },
    route: {
      configuration_version:
        route?.configuration_version === null || route?.configuration_version === undefined
          ? null
          : String(route.configuration_version),
      rule: route?.rule_id ?? null,
      reason: route?.reason ?? null,
      tags: route?.route_tag === null || route?.route_tag === undefined ? [] : [route.route_tag],
      fallback_from: route?.fallback_from ?? null,
      is_final_success_attempt: (event.status ?? "success") === "success",
      is_user_visible_operation: event.attempt_visibility !== "incomplete",
    },
    analytics_dimensions:
      event.gateway_response_cache_hit === null || event.gateway_response_cache_hit === undefined
        ? {}
        : { response_cache_hit: event.gateway_response_cache_hit },
    result: {
      status: event.status ?? "success",
      http_status: event.http_status ?? (event.status === "failure" ? 500 : 200),
      latency_ms: 42,
      error_class: event.error_code ?? null,
    },
    usage: canonicalUsage(event),
    source_cost: null,
    privacy: { contains_prompt: false, contains_response: false },
  };
}

const scenarios = JSON.parse(
  await readFile(
    new URL("../../../fixtures/usage-normalizer/scenarios.json", import.meta.url),
    "utf8",
  ),
) as Scenario[];

const adapter = new LiteLLMStandardLoggingAdapter();

describe("LiteLLM Standard Logging adapter fixtures", () => {
  it.each(scenarios)("normalizes $name", (scenario) => {
    for (const [index, event] of scenario.events.entries()) {
      try {
        const normalized = adapter.normalize(eventFromScenario(scenario, event, index));
        expect(event.expected_error).toBeUndefined();
        expect(normalized).toMatchObject({
          schema_version: "2.0",
          event_id: eventIds[index],
          normalization: {
            normalizer_name: "litellm-standard-logging",
            normalizer_version: "current",
          },
        });
        expect(new Set(normalized.usage_lines.map((line) => line.usage_type)).size).toBe(
          normalized.usage_lines.length,
        );
        expect(normalized.usage_lines).toContainEqual(
          expect.objectContaining({ usage_type: "request", quantity: "1" }),
        );
      } catch (error) {
        expect(error).toBeInstanceOf(NormalizationError);
        expect((error as NormalizationError).code).toBe(event.expected_error);
      }
    }
  });
});

describe("normalizer invariants", () => {
  it("rejects source cost values that cannot fit the comparison snapshot", () => {
    const input = eventFromScenario(
      { name: "source-cost-overflow", events: [] },
      { provider: "openai", actual_model: "gpt-5-mini", present_fields: [] },
      0,
    ) as Record<string, unknown>;
    expect(() =>
      adapter.normalize({
        ...input,
        source_cost: {
          amount: "100000000000000000000",
          currency: "USD",
          is_estimated: false,
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "NORMALIZER_SOURCE_COST_OUT_OF_RANGE" }));
  });

  it("is deterministic and never creates duplicate or negative buckets", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1_000_000 }),
        fc.nat({ max: 1_000_000 }),
        fc.nat({ max: 1_000_000 }),
        fc.nat({ max: 1_000_000 }),
        fc.nat({ max: 1_000_000 }),
        (uncached, cacheRead, cacheWrite, ordinaryOutput, reasoning) => {
          const scenario: Scenario = {
            name: "property",
            events: [
              {
                provider: "openai",
                actual_model: "property-model",
                usage: {
                  input_tokens: uncached + cacheRead + cacheWrite,
                  cache_read_input_tokens: cacheRead,
                  cache_write_input_tokens: cacheWrite,
                  output_tokens: ordinaryOutput + reasoning,
                  reasoning_output_tokens: reasoning,
                },
                present_fields: [
                  "input_tokens",
                  "cache_read_input_tokens",
                  "cache_write_input_tokens",
                  "output_tokens",
                  "reasoning_output_tokens",
                ],
              },
            ],
          };
          const raw = eventFromScenario(scenario, scenario.events[0]!, 0);
          const first = adapter.normalize(raw);
          const second = adapter.normalize(raw);
          expect(second).toEqual(first);
          expect(new Set(first.usage_lines.map((line) => line.usage_type)).size).toBe(
            first.usage_lines.length,
          );
          expect(first.usage_lines.every((line) => Number(line.quantity) >= 0)).toBe(true);
          expect(
            first.usage_lines.find((line) => line.usage_type === "uncached_input_token")?.quantity,
          ).toBe(uncached.toString());
          expect(
            first.usage_lines.find((line) => line.usage_type === "output_token")?.quantity,
          ).toBe(ordinaryOutput.toString());
        },
      ),
      { numRuns: 500 },
    );
  });

  it("returns null for a zero cache denominator and preserves analytics-only gateway cache", () => {
    expect(providerPromptCacheMetrics("0", "0", "0").hitRate).toBeNull();
    const scenario: Scenario = {
      name: "gateway-cache",
      events: [
        {
          provider: "openai",
          actual_model: "gpt-4.1-mini",
          present_fields: [],
          gateway_response_cache_hit: true,
        },
      ],
    };
    const normalized = adapter.normalize(eventFromScenario(scenario, scenario.events[0]!, 0));
    expect(normalized.analytics_dimensions.response_cache_hit).toBe(true);
  });

  it("preserves explicit zero fields while omitting missing fields", () => {
    const scenario: Scenario = {
      name: "presence",
      events: [
        {
          provider: "openai",
          actual_model: "gpt-4.1-mini",
          present_fields: ["input_tokens"],
        },
      ],
    };
    const normalized = adapter.normalize(eventFromScenario(scenario, scenario.events[0]!, 0));
    expect(normalized.usage_lines).toContainEqual(
      expect.objectContaining({ usage_type: "uncached_input_token", quantity: "0" }),
    );
    expect(normalized.usage_lines.some((line) => line.usage_type === "output_token")).toBe(false);
    expect(normalized.normalization.missing_usage_fields).toEqual(
      standardUsageFieldValues.filter(
        (field) => field !== "uncached_input_tokens" && field !== "request_count",
      ),
    );
  });

  it("selects adapters explicitly and rejects unsupported events", () => {
    const supported = usageEventSchema.parse(
      eventFromScenario(
        { name: "supported", events: [] },
        { provider: "openai", actual_model: "model", present_fields: [] },
        0,
      ),
    ) as UsageEvent;
    expect(adapter.supports(supported)).toBe(true);
    expect(normalizeWithAdapters(supported, [adapter]).normalization.normalizer_version).toBe(
      "current",
    );
    expect(() =>
      normalizeWithAdapters(
        { ...supported, source: { ...supported.source, name: "another-gateway" } },
        [adapter],
      ),
    ).toThrowError(expect.objectContaining({ code: "NORMALIZER_UNSUPPORTED_EVENT" }));
  });
});

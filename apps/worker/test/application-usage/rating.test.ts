import { describe, expect, it } from "vitest";

import type { NormalizedUsage } from "@tokenpilot/contracts";
import { Prisma } from "@tokenpilot/db";

import { rateApplicationAiu, rateApplicationCost } from "../../src/application-usage/rating.js";

function normalized(
  usageLines: readonly {
    readonly usage_type: string;
    readonly quantity: string;
    readonly unit_key?: string;
  }[],
  overrides: {
    readonly sourceCost?: NormalizedUsage["source_cost"];
    readonly eventProperties?: Readonly<Record<string, string | number | boolean>>;
    readonly userProperties?: Readonly<Record<string, string | number | boolean>>;
    readonly provider?: string;
  } = {},
): NormalizedUsage {
  return {
    schema_version: "2.0",
    event_id: "01J00000000000000000000000",
    event_time: "2026-07-20T00:00:00.000Z",
    user: { user_id: "user-1", display_user: "Ada" },
    event_properties: overrides.eventProperties,
    user_properties: overrides.userProperties,
    source: { type: "sdk", name: "test", version: "1", instance_id: "instance-1" },
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
      virtual_model: "assistant",
      model_id: "00000000-0000-4000-8000-000000000001",
      connection_id: "00000000-0000-4000-8000-000000000002",
      connection_driver: "openai_compatible",
      request_model: "openai/gpt-test",
      provider: overrides.provider ?? "openai",
    },
    route: null,
    analytics_dimensions: {},
    result: { status: "success", http_status: 200, latency_ms: 100, error_class: null },
    source_cost: overrides.sourceCost ?? null,
    privacy: { contains_prompt: false, contains_response: false },
    normalization: {
      normalizer_name: "test",
      normalizer_version: "1",
      missing_usage_fields: [],
      warnings: [],
    },
    usage_lines: usageLines.map((line) => ({
      ...line,
      unit: line.usage_type.includes("token")
        ? "token"
        : line.usage_type === "request"
          ? "request"
          : line.usage_type === "custom_unit"
            ? "custom"
            : line.usage_type.includes("image")
              ? "image"
              : "second",
      source_path: "test",
      is_estimated: false,
      confidence: "sdk_reported",
    })),
  } as NormalizedUsage;
}

describe("application model rating", () => {
  it("calculates cost from the first matching real-model rule", () => {
    const result = rateApplicationCost(
      {
        id: "cost-current",
        currency: "USD",
        rules: [
          {
            id: "rule-default",
            name: "Default",
            priority: 0,
            matchMode: "all",
            conditionsJson: [],
            fixedAmount: null,
            items: [
              {
                id: "input-rate",
                usageType: "uncached_input_token",
                unitKey: "",
                amountPerUnit: new Prisma.Decimal("0.000002"),
              },
              {
                id: "cache-rate",
                usageType: "cache_read_input_token",
                unitKey: "",
                amountPerUnit: new Prisma.Decimal("0.0000002"),
              },
              {
                id: "output-rate",
                usageType: "output_token",
                unitKey: "",
                amountPerUnit: new Prisma.Decimal("0.000008"),
              },
            ],
          },
        ],
      },
      normalized([
        { usage_type: "uncached_input_token", quantity: "1000" },
        { usage_type: "cache_read_input_token", quantity: "500" },
        { usage_type: "output_token", quantity: "250" },
      ]),
    );

    expect(result).toMatchObject({
      status: "official",
      source: "rule",
      ruleId: "rule-default",
      currency: "USD",
      total: "0.004100000000000000",
    });
    expect(result.lines.map((line) => line.rate_item_id)).toEqual([
      "input-rate",
      "cache-rate",
      "output-rate",
    ]);
  });

  it("converts each token category to integer micro-AIU without losing the total", () => {
    const result = rateApplicationAiu(
      {
        id: "aiu-current",
        items: [
          {
            id: "input-aiu",
            usageType: "uncached_input_token",
            unitKey: "",
            unitSize: new Prisma.Decimal(3),
            aiuMicrosPerUnit: 1n,
          },
          {
            id: "output-aiu",
            usageType: "output_token",
            unitKey: "",
            unitSize: new Prisma.Decimal(3),
            aiuMicrosPerUnit: 1n,
          },
        ],
      },
      [
        { usage_type: "uncached_input_token", quantity: "2" },
        { usage_type: "output_token", quantity: "2" },
      ],
    );

    expect(result.status).toBe("official");
    expect(result.totalMicros).toBe(1n);
    expect(result.lines.map((line) => line.charged_aiu_micros)).toEqual(["1", "0"]);
    expect(
      result.lines.reduce((sum, line) => sum + BigInt(line.charged_aiu_micros ?? "0"), 0n),
    ).toBe(result.totalMicros);
  });

  it("marks the whole result unrated when a non-zero token category has no AIU rate", () => {
    const result = rateApplicationAiu(
      {
        id: "aiu-current",
        items: [
          {
            id: "input-aiu",
            usageType: "uncached_input_token",
            unitKey: "",
            unitSize: new Prisma.Decimal(1_000),
            aiuMicrosPerUnit: 1_000_000n,
          },
        ],
      },
      [
        { usage_type: "uncached_input_token", quantity: "100" },
        { usage_type: "output_token", quantity: "1" },
      ],
    );

    expect(result).toMatchObject({ status: "unrated", totalMicros: null });
    expect(result.lines.find((line) => line.usage_type === "output_token")).toMatchObject({
      rate_item_id: null,
      charged_aiu_micros: null,
    });
  });

  it("allows request cost to be configured without treating it as an AIU token rate", () => {
    const cost = rateApplicationCost(
      {
        id: "cost-current",
        currency: "USD",
        rules: [
          {
            id: "request-rule",
            name: "Request",
            priority: 0,
            matchMode: "all",
            conditionsJson: [],
            fixedAmount: null,
            items: [
              {
                id: "request-rate",
                usageType: "request",
                unitKey: "",
                amountPerUnit: new Prisma.Decimal("0.01"),
              },
            ],
          },
        ],
      },
      normalized([{ usage_type: "request", quantity: "2" }]),
    );
    const aiu = rateApplicationAiu({ id: "aiu-current", items: [] }, [
      { usage_type: "request", quantity: "2" },
    ]);

    expect(cost).toMatchObject({ status: "official", total: "0.020000000000000000" });
    expect(aiu).toMatchObject({ status: "official", totalMicros: 0n, lines: [] });
  });

  it("rates multimodal and custom units by their exact usage type and unit key", () => {
    const usage = [
      { usage_type: "input_image", quantity: "2" },
      { usage_type: "input_audio_second", quantity: "3.5" },
      { usage_type: "custom_unit", unit_key: "gpu_millisecond", quantity: "500" },
    ];
    const cost = rateApplicationCost(
      {
        id: "cost-multimodal",
        currency: "USD",
        rules: [
          {
            id: "multimodal-rule",
            name: "Multimodal",
            priority: 0,
            matchMode: "all",
            conditionsJson: [],
            fixedAmount: null,
            items: [
              {
                id: "image-cost",
                usageType: "input_image",
                unitKey: "",
                amountPerUnit: new Prisma.Decimal("0.01"),
              },
              {
                id: "audio-cost",
                usageType: "input_audio_second",
                unitKey: "",
                amountPerUnit: new Prisma.Decimal("0.002"),
              },
              {
                id: "gpu-cost",
                usageType: "custom_unit",
                unitKey: "gpu_millisecond",
                amountPerUnit: new Prisma.Decimal("0.00004"),
              },
            ],
          },
        ],
      },
      normalized(usage),
    );
    const aiu = rateApplicationAiu(
      {
        id: "aiu-multimodal",
        items: [
          {
            id: "image-aiu",
            usageType: "input_image",
            unitKey: "",
            unitSize: new Prisma.Decimal(1),
            aiuMicrosPerUnit: 1_000_000n,
          },
          {
            id: "audio-aiu",
            usageType: "input_audio_second",
            unitKey: "",
            unitSize: new Prisma.Decimal(1),
            aiuMicrosPerUnit: 100_000n,
          },
          {
            id: "gpu-aiu",
            usageType: "custom_unit",
            unitKey: "gpu_millisecond",
            unitSize: new Prisma.Decimal(1_000),
            aiuMicrosPerUnit: 2_000_000n,
          },
        ],
      },
      usage,
    );

    expect(cost).toMatchObject({ status: "official", total: "0.047000000000000000" });
    expect(aiu).toMatchObject({ status: "official", totalMicros: 3_350_000n });
    expect(cost.lines.map((line) => line.rate_item_id)).toEqual([
      "image-cost",
      "audio-cost",
      "gpu-cost",
    ]);
  });

  it("marks cost unpriced when no reported amount or conditional rule is available", () => {
    const usage = [
      { usage_type: "output_video_second", quantity: "1" },
      { usage_type: "custom_unit", unit_key: "tool_call", quantity: "2" },
    ];
    const cost = rateApplicationCost(
      { id: "cost-partial", currency: "USD", rules: [] },
      normalized(usage),
    );
    const aiu = rateApplicationAiu({ id: "aiu-partial", items: [] }, usage);

    expect(cost).toMatchObject({ status: "unpriced", total: null });
    expect(aiu).toMatchObject({ status: "unrated", totalMicros: null });
    expect(cost.lines).toEqual([]);
    expect(aiu.lines).toHaveLength(2);
  });

  it("uses a source-reported amount before evaluating fallback rules", () => {
    const result = rateApplicationCost(
      {
        id: "cost-current",
        currency: "CNY",
        rules: [
          {
            id: "fallback-rule",
            name: "Fallback",
            priority: 0,
            matchMode: "all",
            conditionsJson: [],
            fixedAmount: new Prisma.Decimal("99"),
            items: [],
          },
        ],
      },
      normalized([{ usage_type: "output_token", quantity: "10" }], {
        sourceCost: { amount: "0.0125", currency: "USD", is_estimated: false },
      }),
    );

    expect(result).toMatchObject({
      status: "official",
      source: "reported",
      versionId: null,
      ruleId: null,
      currency: "USD",
      total: "0.012500000000000000",
      lines: [],
    });
  });

  it("matches built-in and custom properties in priority order", () => {
    const result = rateApplicationCost(
      {
        id: "cost-current",
        currency: "USD",
        rules: [
          {
            id: "enterprise-rule",
            name: "Enterprise voice",
            priority: 0,
            matchMode: "all",
            conditionsJson: [
              { kind: "builtin", field: "provider", operator: "equals", values: ["openai"] },
              {
                kind: "property",
                scope: "user",
                key: "tier",
                operator: "equals",
                values: ["enterprise"],
              },
              {
                kind: "property",
                scope: "event",
                key: "voice_seconds",
                operator: "greater_or_equal",
                values: [10],
              },
            ],
            fixedAmount: new Prisma.Decimal("0.25"),
            items: [],
          },
          {
            id: "default-rule",
            name: "Default",
            priority: 1,
            matchMode: "all",
            conditionsJson: [],
            fixedAmount: new Prisma.Decimal("1"),
            items: [],
          },
        ],
      },
      normalized([{ usage_type: "request", quantity: "1" }], {
        eventProperties: { voice_seconds: 30 },
        userProperties: { tier: "enterprise" },
      }),
    );

    expect(result).toMatchObject({
      source: "rule",
      ruleId: "enterprise-rule",
      total: "0.250000000000000000",
    });
  });
});

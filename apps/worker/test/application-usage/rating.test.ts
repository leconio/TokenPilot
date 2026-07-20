import { describe, expect, it } from "vitest";

import { Prisma } from "@tokenpilot/db";

import { rateApplicationAiu, rateApplicationCost } from "../../src/application-usage/rating.js";

describe("application model rating", () => {
  it("prices input, cached input, and output with the real model's published rates", () => {
    const result = rateApplicationCost(
      {
        id: "cost-current",
        currency: "USD",
        items: [
          {
            id: "input-rate",
            usageType: "uncached_input_token",
            unitKey: "",
            unitSize: new Prisma.Decimal(1_000),
            unitPrice: new Prisma.Decimal("0.002"),
          },
          {
            id: "cache-rate",
            usageType: "cache_read_input_token",
            unitKey: "",
            unitSize: new Prisma.Decimal(1_000),
            unitPrice: new Prisma.Decimal("0.0002"),
          },
          {
            id: "output-rate",
            usageType: "output_token",
            unitKey: "",
            unitSize: new Prisma.Decimal(1_000),
            unitPrice: new Prisma.Decimal("0.008"),
          },
        ],
      },
      [
        { usage_type: "uncached_input_token", quantity: "1000" },
        { usage_type: "cache_read_input_token", quantity: "500" },
        { usage_type: "output_token", quantity: "250" },
      ],
    );

    expect(result).toMatchObject({
      status: "official",
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
        items: [
          {
            id: "request-rate",
            usageType: "request",
            unitKey: "",
            unitSize: new Prisma.Decimal(1),
            unitPrice: new Prisma.Decimal("0.01"),
          },
        ],
      },
      [{ usage_type: "request", quantity: "2" }],
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
        items: [
          {
            id: "image-cost",
            usageType: "input_image",
            unitKey: "",
            unitSize: new Prisma.Decimal(1),
            unitPrice: new Prisma.Decimal("0.01"),
          },
          {
            id: "audio-cost",
            usageType: "input_audio_second",
            unitKey: "",
            unitSize: new Prisma.Decimal(1),
            unitPrice: new Prisma.Decimal("0.002"),
          },
          {
            id: "gpu-cost",
            usageType: "custom_unit",
            unitKey: "gpu_millisecond",
            unitSize: new Prisma.Decimal(1_000),
            unitPrice: new Prisma.Decimal("0.04"),
          },
        ],
      },
      usage,
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

  it("does not silently ignore a multimodal or custom unit with no matching rate", () => {
    const usage = [
      { usage_type: "output_video_second", quantity: "1" },
      { usage_type: "custom_unit", unit_key: "tool_call", quantity: "2" },
    ];
    const cost = rateApplicationCost({ id: "cost-partial", currency: "USD", items: [] }, usage);
    const aiu = rateApplicationAiu({ id: "aiu-partial", items: [] }, usage);

    expect(cost).toMatchObject({ status: "unpriced", total: null });
    expect(aiu).toMatchObject({ status: "unrated", totalMicros: null });
    expect(cost.lines).toEqual([
      expect.objectContaining({ usage_type: "output_video_second", rate_item_id: null }),
      expect.objectContaining({ unit_key: "tool_call", rate_item_id: null }),
    ]);
    expect(aiu.lines).toHaveLength(2);
  });
});

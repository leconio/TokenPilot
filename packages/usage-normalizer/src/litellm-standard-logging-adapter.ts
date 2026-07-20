import { Decimal } from "decimal.js";

import {
  normalizedUsageSchema,
  usageEventSchema,
  type NormalizedUsage,
  type UsageConfidence,
  type UsageEvent,
  type UsageLine,
} from "@tokenpilot/contracts";

import { NormalizationError } from "./errors.js";
import type { UsageAdapter } from "./types.js";

const MAX_QUANTITY_EXCLUSIVE = new Decimal("1e29");
const MAX_MONEY_EXCLUSIVE = new Decimal("1e20");
const ADAPTER_NAME = "litellm-standard-logging";

const STANDARD_USAGE = {
  uncached_input_tokens: ["uncached_input_token", "token"],
  cache_read_input_tokens: ["cache_read_input_token", "token"],
  cache_write_input_tokens: ["cache_write_input_token", "token"],
  output_tokens: ["output_token", "token"],
  reasoning_output_tokens: ["reasoning_output_token", "token"],
  input_images: ["input_image", "image"],
  output_images: ["output_image", "image"],
  input_audio_seconds: ["input_audio_second", "second"],
  output_audio_seconds: ["output_audio_second", "second"],
  input_video_seconds: ["input_video_second", "second"],
  output_video_seconds: ["output_video_second", "second"],
  embedding_tokens: ["embedding_token", "token"],
  request_count: ["request", "request"],
} as const;

export type StandardUsageField = keyof typeof STANDARD_USAGE;
export const standardUsageFieldValues = Object.freeze(
  Object.keys(STANDARD_USAGE) as StandardUsageField[],
);

function confidence(event: UsageEvent): UsageConfidence {
  if (event.source.type === "gateway") return "gateway_reported";
  if (event.source.type === "sdk") return "sdk_reported";
  return "estimated";
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function decimal(value: unknown): Decimal | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    const result = new Decimal(value);
    return result.isFinite() ? result : null;
  } catch {
    return null;
  }
}

function hasOutOfRangeUsageQuantity(input: unknown): boolean {
  const usage = record(record(input)?.usage);
  if (usage === null) return false;
  return standardUsageFieldValues.some((field) => {
    const value = decimal(usage[field]);
    return (
      value !== null && !value.isNegative() && value.greaterThanOrEqualTo(MAX_QUANTITY_EXCLUSIVE)
    );
  });
}

function hasOutOfRangeSourceCost(input: unknown): boolean {
  const sourceCost = record(record(input)?.source_cost);
  const amount = decimal(sourceCost?.amount);
  return (
    amount !== null && !amount.isNegative() && amount.greaterThanOrEqualTo(MAX_MONEY_EXCLUSIVE)
  );
}

function usageLines(event: UsageEvent): UsageLine[] {
  const sourceConfidence = confidence(event);
  const lines: UsageLine[] = [];
  for (const field of standardUsageFieldValues) {
    const quantity = event.usage[field];
    if (quantity === undefined) continue;
    const [usageType, unit] = STANDARD_USAGE[field];
    lines.push({
      usage_type: usageType,
      quantity,
      unit,
      source_path: `usage.${field}`,
      is_estimated: sourceConfidence === "estimated",
      confidence: sourceConfidence,
    });
  }
  for (const custom of event.usage.custom_units ?? []) {
    lines.push({
      usage_type: "custom_unit",
      unit_key: custom.unit_key,
      quantity: custom.quantity,
      unit: "custom",
      source_path: custom.source_path,
      is_estimated: custom.is_estimated || sourceConfidence === "estimated",
      confidence: custom.is_estimated ? "estimated" : sourceConfidence,
    });
  }
  return lines;
}

export class LiteLLMStandardLoggingAdapter implements UsageAdapter {
  readonly adapterName = ADAPTER_NAME;
  readonly adapterVersion = "current";

  supports(input: unknown): boolean {
    const parsed = usageEventSchema.safeParse(input);
    return (
      parsed.success &&
      parsed.data.source.type === "gateway" &&
      parsed.data.source.name.toLowerCase().includes("litellm")
    );
  }

  normalize(input: unknown): NormalizedUsage {
    const parsed = usageEventSchema.safeParse(input);
    if (!parsed.success) {
      if (hasOutOfRangeSourceCost(input)) {
        throw new NormalizationError(
          "NORMALIZER_SOURCE_COST_OUT_OF_RANGE",
          "source_cost cannot be represented as numeric(38,18).",
        );
      }
      if (hasOutOfRangeUsageQuantity(input)) {
        throw new NormalizationError(
          "NORMALIZER_QUANTITY_OUT_OF_RANGE",
          "A usage quantity cannot be represented as numeric(38,9).",
        );
      }
      throw new NormalizationError(
        "NORMALIZER_INVALID_EVENT",
        "The raw event does not satisfy the canonical Usage Event contract.",
      );
    }
    const event = parsed.data;
    if (!this.supports(event)) {
      throw new NormalizationError(
        "NORMALIZER_UNSUPPORTED_EVENT",
        "The event is not a LiteLLM gateway usage event.",
      );
    }
    return this.normalizeEvent(event);
  }

  private normalizeEvent(event: UsageEvent): NormalizedUsage {
    return normalizedUsageSchema.parse({
      schema_version: event.schema_version,
      event_id: event.event_id,
      event_time: event.event_time,
      user: event.user,
      ...(event.application_version === undefined
        ? {}
        : { application_version: event.application_version }),
      ...(event.sdk_version === undefined ? {} : { sdk_version: event.sdk_version }),
      ...(event.connector_version === undefined
        ? {}
        : { connector_version: event.connector_version }),
      ...(event.config_version === undefined ? {} : { config_version: event.config_version }),
      ...(event.event_properties === undefined ? {} : { event_properties: event.event_properties }),
      ...(event.user_properties === undefined ? {} : { user_properties: event.user_properties }),
      source: event.source,
      request: event.request,
      model: event.model,
      route: event.route,
      analytics_dimensions: event.analytics_dimensions,
      result: event.result,
      source_cost: event.source_cost,
      privacy: event.privacy,
      normalization: {
        normalizer_name: ADAPTER_NAME,
        normalizer_version: this.adapterVersion,
        missing_usage_fields: standardUsageFieldValues.filter(
          (field) => event.usage[field] === undefined,
        ),
        warnings: [],
      },
      usage_lines: usageLines(event),
    });
  }
}

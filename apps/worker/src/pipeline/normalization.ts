import {
  normalizedUsageSchema,
  usageEventSchema,
  type NormalizedUsage,
  type UsageConfidence,
  type UsageEvent,
  type UsageLine,
} from "@tokenpilot/contracts";

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

function confidence(event: UsageEvent): UsageConfidence {
  if (event.source.type === "gateway") return "gateway_reported";
  if (event.source.type === "sdk") return "sdk_reported";
  return "estimated";
}

function usageLines(event: UsageEvent): UsageLine[] {
  const sourceConfidence = confidence(event);
  const lines: UsageLine[] = [];
  for (const [field, [usageType, unit]] of Object.entries(STANDARD_USAGE)) {
    const quantity = event.usage[field as keyof typeof STANDARD_USAGE];
    if (typeof quantity !== "string") continue;
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

/** Converts the accepted wire payload into the one canonical, mutually-exclusive line representation. */
export function normalizeUsageEvent(payload: unknown): NormalizedUsage {
  const event = usageEventSchema.parse(payload);
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
      normalizer_name: "usage-event",
      normalizer_version: "current",
      missing_usage_fields: Object.keys(STANDARD_USAGE).filter(
        (field) => event.usage[field as keyof typeof STANDARD_USAGE] === undefined,
      ),
      warnings: [],
    },
    usage_lines: usageLines(event),
  });
}

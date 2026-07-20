import { z } from "zod";

import { routeTagSchema, virtualModelNameSchema } from "./common.js";
import { analyticsDimensionsSchema } from "./usage-context.js";
import { callConnectionDriverSchema } from "./model-runtime.js";
import {
  boundedUnicodeStringSchema,
  currencyCodeSchema,
  decimal38_18Schema,
  decimal38_9Schema,
  eventIdSchema,
  opaqueIdSchema,
  resultStatusSchema,
  sourcePathSchema,
  unitKeySchema,
  usageConfidenceSchema,
  type UsageType,
  usageTypeSchema,
  utcTimestampSchema,
} from "./primitives.js";

export const usageSourceTypeValues = ["gateway", "sdk", "import", "reconciler", "unknown"] as const;

export const usageUnitValues = [
  "token",
  "image",
  "second",
  "request",
  "custom",
  "unknown",
] as const;

export const normalizationWarningValues = ["model_unmapped", "unknown"] as const;

export const usageSourceTypeSchema = z.enum(usageSourceTypeValues).meta({
  id: "UsageSourceType",
});
export const usageUnitSchema = z.enum(usageUnitValues).meta({ id: "UsageUnit" });
export const normalizationWarningSchema = z.enum(normalizationWarningValues).meta({
  id: "NormalizationWarning",
});

const nullableBoundedStringSchema = boundedUnicodeStringSchema({
  minLength: 1,
  maxLength: 256,
}).nullable();

const propertyKeySchema = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9._-]{0,127}$/u, "Expected a stable property key");
const propertyTextListSchema = z
  .array(boundedUnicodeStringSchema({ minLength: 1, maxLength: 256 }))
  .max(32)
  .refine((values) => new Set(values).size === values.length, "Expected unique list values");
const propertyValueSchema = z.union([
  boundedUnicodeStringSchema({ minLength: 1, maxLength: 2_048 }),
  z.number().finite().safe(),
  z.boolean(),
  propertyTextListSchema,
]);
const typedPropertiesSchema = z
  .record(propertyKeySchema, propertyValueSchema)
  .refine((properties) => Object.keys(properties).length <= 64, "Expected at most 64 properties");

const usageUserSchema = z.strictObject({
  user_id: boundedUnicodeStringSchema({ minLength: 1, maxLength: 256 }),
  display_user: boundedUnicodeStringSchema({ minLength: 1, maxLength: 256 }).nullable().optional(),
});

const usageSourceSchema = z.strictObject({
  type: usageSourceTypeSchema,
  name: boundedUnicodeStringSchema({ minLength: 1, maxLength: 120 }),
  version: boundedUnicodeStringSchema({ minLength: 1, maxLength: 64 }),
  instance_id: boundedUnicodeStringSchema({ minLength: 1, maxLength: 256 }),
});

const usageRequestSchema = z.strictObject({
  request_id: opaqueIdSchema,
  attempt_id: opaqueIdSchema,
  attempt_index: z.number().int().safe().min(0).max(63),
  is_final_attempt: z.boolean(),
  operation_id: opaqueIdSchema.nullable(),
  parent_request_id: opaqueIdSchema.nullable(),
  session_id: opaqueIdSchema.nullable(),
  conversation_id: opaqueIdSchema.nullable(),
  trace_id: opaqueIdSchema.nullable(),
  reservation_id: opaqueIdSchema.nullable().optional(),
});

const usageModelSchema = z.strictObject({
  virtual_model: virtualModelNameSchema.nullable().optional(),
  model_id: opaqueIdSchema.nullable().optional(),
  connection_id: opaqueIdSchema.nullable().optional(),
  connection_driver: callConnectionDriverSchema.nullable().optional(),
  request_model: boundedUnicodeStringSchema({ minLength: 1, maxLength: 256 }),
  provider: nullableBoundedStringSchema.optional(),
});

const usageRouteSchema = z.strictObject({
  configuration_version: nullableBoundedStringSchema,
  rule: nullableBoundedStringSchema,
  reason: nullableBoundedStringSchema,
  tags: z
    .array(routeTagSchema)
    .max(16)
    .refine((tags) => new Set(tags).size === tags.length, "Expected unique route tags"),
  fallback_from: nullableBoundedStringSchema,
  is_final_success_attempt: z.boolean(),
  is_user_visible_operation: z.boolean().optional(),
});

const usageResultSchema = z.strictObject({
  status: resultStatusSchema,
  http_status: z.number().int().min(100).max(599).nullable(),
  latency_ms: z.number().int().safe().nonnegative().nullable(),
  error_class: nullableBoundedStringSchema,
});

const sourceCostSchema = z
  .strictObject({
    amount: decimal38_18Schema,
    currency: currencyCodeSchema,
    is_estimated: z.boolean(),
  })
  .nullable();

const usagePrivacySchema = z.strictObject({
  contains_prompt: z.literal(false),
  contains_response: z.literal(false),
});

const rawCustomUnitSchema = z.strictObject({
  unit_key: unitKeySchema,
  quantity: decimal38_9Schema,
  unit: unitKeySchema,
  source_path: sourcePathSchema,
  is_estimated: z.boolean(),
});

const rawUsageSchema = z
  .strictObject({
    uncached_input_tokens: decimal38_9Schema.optional(),
    cache_read_input_tokens: decimal38_9Schema.optional(),
    cache_write_input_tokens: decimal38_9Schema.optional(),
    output_tokens: decimal38_9Schema.optional(),
    reasoning_output_tokens: decimal38_9Schema.optional(),
    input_images: decimal38_9Schema.optional(),
    output_images: decimal38_9Schema.optional(),
    input_audio_seconds: decimal38_9Schema.optional(),
    output_audio_seconds: decimal38_9Schema.optional(),
    input_video_seconds: decimal38_9Schema.optional(),
    output_video_seconds: decimal38_9Schema.optional(),
    embedding_tokens: decimal38_9Schema.optional(),
    request_count: decimal38_9Schema.optional(),
    custom_units: z.array(rawCustomUnitSchema).max(32).optional(),
  })
  .superRefine((usage, context) => {
    const standardBucketCount = Object.entries(usage).filter(
      ([key, value]) => key !== "custom_units" && value !== undefined,
    ).length;
    const customUnits = usage.custom_units ?? [];
    if (standardBucketCount === 0 && customUnits.length === 0) {
      context.addIssue({ code: "custom", message: "Expected at least one usage bucket" });
    }

    const customUnitKeys = customUnits.map((unit) => unit.unit_key);
    if (new Set(customUnitKeys).size !== customUnitKeys.length) {
      context.addIssue({
        code: "custom",
        message: "Expected unique custom unit keys",
        path: ["custom_units"],
      });
    }
  });

export type UsageUnit = z.infer<typeof usageUnitSchema>;

export const usageUnitsByType = {
  uncached_input_token: "token",
  cache_read_input_token: "token",
  cache_write_input_token: "token",
  output_token: "token",
  reasoning_output_token: "token",
  input_image: "image",
  output_image: "image",
  input_audio_second: "second",
  output_audio_second: "second",
  input_video_second: "second",
  output_video_second: "second",
  embedding_token: "token",
  request: "request",
  custom_unit: "custom",
  unknown: "unknown",
} as const satisfies Readonly<Record<UsageType, UsageUnit>>;

export function usageUnitForType(usageType: UsageType): UsageUnit {
  return usageUnitsByType[usageType];
}

export const usageLineSchema = z
  .strictObject({
    usage_type: usageTypeSchema,
    quantity: decimal38_9Schema,
    unit: usageUnitSchema,
    unit_key: unitKeySchema.optional(),
    source_path: sourcePathSchema,
    is_estimated: z.boolean(),
    confidence: usageConfidenceSchema,
  })
  .superRefine((line, context) => {
    if (line.usage_type === "custom_unit") {
      if (line.unit_key === undefined) {
        context.addIssue({
          code: "custom",
          message: "custom_unit requires unit_key",
          path: ["unit_key"],
        });
      }
      if (line.unit !== "custom") {
        context.addIssue({
          code: "custom",
          message: "custom_unit requires the custom unit",
          path: ["unit"],
        });
      }
      return;
    }

    if (line.unit_key !== undefined) {
      context.addIssue({
        code: "custom",
        message: "unit_key is forbidden for non-custom usage",
        path: ["unit_key"],
      });
    }
    const expectedUnit = usageUnitForType(line.usage_type);
    if (line.unit !== expectedUnit) {
      context.addIssue({
        code: "custom",
        message: `${line.usage_type} requires the ${expectedUnit} unit`,
        path: ["unit"],
      });
    }
  });

function usageLineIdentity(line: z.infer<typeof usageLineSchema>): string {
  return line.usage_type === "custom_unit"
    ? `custom_unit:${line.unit_key ?? "<missing>"}`
    : line.usage_type;
}

const usageLinesSchema = z
  .array(usageLineSchema)
  .min(1)
  .max(64)
  .superRefine((lines, context) => {
    const seen = new Set<string>();
    lines.forEach((line, index) => {
      const identity = usageLineIdentity(line);
      if (seen.has(identity)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate mutually exclusive usage bucket ${identity}`,
          path: [index, "usage_type"],
        });
      }
      seen.add(identity);
    });
  });

const eventEnvelopeShape = {
  schema_version: z.literal("2.0"),
  event_id: eventIdSchema,
  event_time: utcTimestampSchema,
  application_version: boundedUnicodeStringSchema({ minLength: 1, maxLength: 64 }).optional(),
  sdk_version: boundedUnicodeStringSchema({ minLength: 1, maxLength: 64 }).optional(),
  connector_version: boundedUnicodeStringSchema({ minLength: 1, maxLength: 64 }).optional(),
  config_version: boundedUnicodeStringSchema({ minLength: 1, maxLength: 64 }).optional(),
  user: usageUserSchema,
  event_properties: typedPropertiesSchema.optional(),
  user_properties: typedPropertiesSchema.optional(),
  source: usageSourceSchema,
  request: usageRequestSchema,
  model: usageModelSchema,
  route: usageRouteSchema.nullable(),
  analytics_dimensions: analyticsDimensionsSchema,
  result: usageResultSchema,
  source_cost: sourceCostSchema,
  privacy: usagePrivacySchema,
} as const;

export const usageEventSchema = z
  .strictObject({
    ...eventEnvelopeShape,
    usage: rawUsageSchema,
  })
  .meta({
    id: "UsageEvent",
    title: "Usage Event",
    description: "A privacy-preserving raw usage event with mutually exclusive usage buckets.",
  });

export const usageBatchSchema = z
  .strictObject({
    schema_version: z.literal("2.0"),
    batch_id: opaqueIdSchema,
    sent_at: utcTimestampSchema,
    events: z.array(usageEventSchema).min(1).max(1000),
  })
  .superRefine((batch, context) => {
    const seen = new Set<string>();
    batch.events.forEach((event, index) => {
      if (seen.has(event.event_id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate event_id ${event.event_id}`,
          path: ["events", index, "event_id"],
        });
      }
      seen.add(event.event_id);
    });
  })
  .meta({
    id: "UsageBatch",
    title: "Usage Batch",
  });

export const normalizedUsageSchema = z
  .strictObject({
    ...eventEnvelopeShape,
    normalization: z.strictObject({
      normalizer_name: boundedUnicodeStringSchema({ minLength: 1, maxLength: 120 }),
      normalizer_version: boundedUnicodeStringSchema({ minLength: 1, maxLength: 64 }),
      missing_usage_fields: z
        .array(boundedUnicodeStringSchema({ minLength: 1, maxLength: 128 }))
        .max(32)
        .refine(
          (fields) => new Set(fields).size === fields.length,
          "Expected unique missing usage fields",
        ),
      warnings: z
        .array(normalizationWarningSchema)
        .max(normalizationWarningValues.length)
        .refine(
          (warnings) => new Set(warnings).size === warnings.length,
          "Expected unique normalization warnings",
        ),
    }),
    usage_lines: usageLinesSchema,
  })
  .meta({
    id: "NormalizedUsage",
    title: "Normalized Usage",
    description: "A normalized usage event with exclusive, rating-ready line items.",
  });

export type UsageEvent = z.infer<typeof usageEventSchema>;
export type UsageBatch = z.infer<typeof usageBatchSchema>;
export type UsageLine = z.infer<typeof usageLineSchema>;
export type NormalizedUsage = z.infer<typeof normalizedUsageSchema>;
export type NormalizationWarning = z.infer<typeof normalizationWarningSchema>;

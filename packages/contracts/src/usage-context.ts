import { z } from "zod";

import { DIMENSION_KEY_PATTERN, dimensionKeySchema, dimensionValueSchema } from "./primitives.js";

export const MAX_DIMENSION_COUNT = 32;
export const MAX_DIMENSION_UTF8_BYTES = 8192;

export const reservedDimensionKeys = [
  "user_id",
  "virtual_model",
  "model",
  "model_tag",
  "provider",
  "route_reason",
  "operation_id",
] as const;

const reservedDimensionKeySet = new Set<string>(reservedDimensionKeys);

function dimensionMapUtf8Bytes(value: Readonly<Record<string, unknown>>): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function refineDimensionMap(
  value: Readonly<Record<string, unknown>>,
  context: z.RefinementCtx,
): void {
  const keys = Object.keys(value);
  if (keys.length > MAX_DIMENSION_COUNT) {
    context.addIssue({
      code: "custom",
      message: `Expected at most ${MAX_DIMENSION_COUNT} dimensions`,
    });
  }

  for (const key of keys) {
    if (key.startsWith("cp_") || reservedDimensionKeySet.has(key)) {
      context.addIssue({
        code: "custom",
        message: `Dimension key ${key} is reserved`,
        path: [key],
      });
    }
  }

  if (dimensionMapUtf8Bytes(value) > MAX_DIMENSION_UTF8_BYTES) {
    context.addIssue({
      code: "custom",
      message: `Expected dimensions to use at most ${MAX_DIMENSION_UTF8_BYTES} UTF-8 bytes`,
    });
  }
}

function governedDimensionMapSchema(): z.ZodType<Record<string, string | number | boolean>> {
  return z.record(dimensionKeySchema, dimensionValueSchema).superRefine(refineDimensionMap);
}

export const analyticsDimensionsSchema = governedDimensionMapSchema().meta({
  id: "AnalyticsDimensions",
  title: "Analytics Dimensions",
  description: "Custom dimensions used only for usage analysis and reports.",
  maxProperties: MAX_DIMENSION_COUNT,
  propertyNames: { pattern: DIMENSION_KEY_PATTERN.source },
});

export type AnalyticsDimensions = z.infer<typeof analyticsDimensionsSchema>;

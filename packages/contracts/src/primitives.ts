import { z } from "zod";

import { isRealUtcDateTime, ULID_PATTERN } from "./common.js";

export const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/u;
export const SHA256_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
export const DIMENSION_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
export const UNIT_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/u;
export const SOURCE_PATH_PATTERN = /^(?:[A-Za-z0-9_.$-]|\u005b|\u005d)+$/u;

const DECIMAL_38_18_PATTERN = /^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/u;
const SIGNED_DECIMAL_38_18_PATTERN = /^-?(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/u;
const DECIMAL_38_9_PATTERN = /^(?:0|[1-9][0-9]{0,28})(?:\.[0-9]{1,9})?$/u;
const UINT64_CANONICAL_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/u;
const INT64_CANONICAL_PATTERN = /^(?:0|[1-9][0-9]{0,18}|-[1-9][0-9]{0,18})$/u;

const UINT64_MAXIMUM = 9_223_372_036_854_775_807n;
const INT64_MINIMUM = -9_223_372_036_854_775_808n;
const UNPAIRED_UTF16_SURROGATE_PATTERN = /[\uD800-\uDFFF]/u;
const UUID_V7_EXPLICIT_CASE_PATTERN =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-7[0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$/u;
const UTC_RFC3339_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u;

export interface BoundedUnicodeStringOptions {
  readonly minLength?: number;
  readonly maxLength: number;
}

/**
 * Creates a bounded free-form string whose limits use Unicode code points.
 *
 * JSON Schema counts Unicode code points, while JavaScript's native string
 * length counts UTF-16 code units. Keeping the limits in metadata preserves
 * the canonical wire constraints without reintroducing UTF-16 semantics at
 * runtime.
 */
export function boundedUnicodeStringSchema({ minLength, maxLength }: BoundedUnicodeStringOptions) {
  if (!Number.isSafeInteger(maxLength) || maxLength < 0) {
    throw new RangeError("maxLength must be a non-negative safe integer");
  }
  if (
    minLength !== undefined &&
    (!Number.isSafeInteger(minLength) || minLength < 0 || minLength > maxLength)
  ) {
    throw new RangeError("minLength must be a non-negative safe integer no larger than maxLength");
  }

  const metadata = minLength === undefined ? { maxLength } : { minLength, maxLength };
  return z
    .string()
    .superRefine((value, context) => {
      if (UNPAIRED_UTF16_SURROGATE_PATTERN.test(value)) {
        context.addIssue({
          code: "custom",
          message: "Expected only portable Unicode scalar values",
        });
        return;
      }

      const codePointLength = Array.from(value).length;
      if (minLength !== undefined && codePointLength < minLength) {
        context.addIssue({
          code: "custom",
          message: `Expected at least ${minLength} Unicode code points`,
        });
      }
      if (codePointLength > maxLength) {
        context.addIssue({
          code: "custom",
          message: `Expected at most ${maxLength} Unicode code points`,
        });
      }
    })
    .meta(metadata);
}

function inUnsignedInt64Range(value: string): boolean {
  return BigInt(value) <= UINT64_MAXIMUM;
}

function inSignedInt64Range(value: string): boolean {
  const parsed = BigInt(value);
  return parsed >= INT64_MINIMUM && parsed <= UINT64_MAXIMUM;
}

export const eventIdSchema = z
  .union([
    z.string().regex(ULID_PATTERN, "Expected a ULID"),
    z.string().regex(UUID_V7_EXPLICIT_CASE_PATTERN, "Expected a UUIDv7"),
  ])
  .meta({
    id: "EventId",
    title: "Event ID",
    description: "A globally idempotent ULID or UUIDv7 event identifier.",
  });

export const opaqueIdSchema = z.string().regex(OPAQUE_ID_PATTERN, "Expected an opaque identifier");

export const utcTimestampSchema = z
  .string()
  .regex(UTC_RFC3339_PATTERN, "Expected an RFC3339 UTC timestamp ending in Z")
  .refine(isRealUtcDateTime, "Expected a real calendar timestamp");

export const currencyCodeSchema = z
  .string()
  .regex(CURRENCY_CODE_PATTERN, "Expected an ISO 4217 currency code");

export const sha256FingerprintSchema = z
  .string()
  .regex(SHA256_FINGERPRINT_PATTERN, "Expected a sha256:<lowercase hex> fingerprint");

export const decimal38_18Schema = z
  .string()
  .regex(DECIMAL_38_18_PATTERN, "Expected a canonical non-negative numeric(38,18) string")
  .meta({ id: "Decimal38Scale18" });

export const signedDecimal38_18Schema = z
  .string()
  .regex(SIGNED_DECIMAL_38_18_PATTERN, "Expected a canonical signed numeric(38,18) string")
  .refine((value) => !/^-0(?:\.0+)?$/u.test(value), "Negative zero is not canonical")
  .meta({ id: "SignedDecimal38Scale18" });

export const decimal38_9Schema = z
  .string()
  .regex(DECIMAL_38_9_PATTERN, "Expected a canonical non-negative numeric(38,9) string")
  .meta({ id: "Decimal38Scale9" });

export const microAiuStringSchema = z
  .string()
  .regex(UINT64_CANONICAL_PATTERN, "Expected a canonical non-negative int64 decimal string")
  .refine(inUnsignedInt64Range, "Expected a non-negative signed-int64 value")
  .meta({
    id: "MicroAiuString",
    format: "nonnegative-int64-string",
    description: "A canonical decimal string in the non-negative signed-int64 range.",
  });

export const signedMicroAiuStringSchema = z
  .string()
  .regex(INT64_CANONICAL_PATTERN, "Expected a canonical signed int64 decimal string")
  .refine(inSignedInt64Range, "Expected a signed-int64 value")
  .meta({
    id: "SignedMicroAiuString",
    format: "int64-string",
    description: "A canonical decimal string in the signed-int64 range.",
  });

export const dimensionKeySchema = z
  .string()
  .regex(DIMENSION_KEY_PATTERN, "Expected a normalized dimension key");

export const dimensionValueSchema = z.union([
  boundedUnicodeStringSchema({ maxLength: 256 }),
  z.number().int().safe(),
  z.boolean(),
]);

export const unitKeySchema = z
  .string()
  .regex(UNIT_KEY_PATTERN, "Expected a normalized custom-unit key");

export const sourcePathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(SOURCE_PATH_PATTERN, "Expected a content-free source field path");

export const usageTypeValues = [
  "uncached_input_token",
  "cache_read_input_token",
  "cache_write_input_token",
  "output_token",
  "reasoning_output_token",
  "input_image",
  "output_image",
  "input_audio_second",
  "output_audio_second",
  "input_video_second",
  "output_video_second",
  "embedding_token",
  "request",
  "custom_unit",
  "unknown",
] as const;

export const usageConfidenceValues = [
  "exact_provider_response",
  "gateway_reported",
  "sdk_reported",
  "estimated",
] as const;

export const aiuModeValues = [
  "disabled",
  "observe",
  "soft_limit",
  "hard_limit",
  "unknown",
] as const;

export const resultStatusValues = [
  "success",
  "failure",
  "cancelled",
  "timeout",
  "unknown",
] as const;
export const usageTypeSchema = z.enum(usageTypeValues).meta({
  id: "UsageType",
  title: "Usage Type",
  description: "A mutually exclusive canonical usage bucket.",
});
export const usageConfidenceSchema = z.enum(usageConfidenceValues).meta({
  id: "UsageConfidence",
});
export const aiuModeSchema = z.enum(aiuModeValues).meta({ id: "AiuMode" });
export const resultStatusSchema = z.enum(resultStatusValues).meta({ id: "ResultStatus" });

export type UsageType = z.infer<typeof usageTypeSchema>;
export type UsageConfidence = z.infer<typeof usageConfidenceSchema>;

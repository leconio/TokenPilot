import { z } from "zod";

import { boundedUnicodeStringSchema, opaqueIdSchema } from "./primitives.js";

export const callConnectionDriverValues = ["litellm", "openai_compatible", "anthropic"] as const;

export const callConnectionStatusValues = [
  "unverified",
  "available",
  "degraded",
  "offline",
] as const;

export const modelTaskTypeValues = ["chat", "embedding", "image", "audio"] as const;

export const modelCapabilityValues = [
  "streaming",
  "tools",
  "structured_output",
  "image_input",
  "audio_input",
  "audio_output",
  "cache_metering",
  "reasoning",
] as const;

export const callConnectionDriverSchema = z.enum(callConnectionDriverValues).meta({
  id: "CallConnectionDriver",
});

export const callConnectionStatusSchema = z.enum(callConnectionStatusValues).meta({
  id: "CallConnectionStatus",
});

export const modelTaskTypeSchema = z.enum(modelTaskTypeValues).meta({ id: "ModelTaskType" });
export const modelCapabilitySchema = z.enum(modelCapabilityValues).meta({ id: "ModelCapability" });

export const modelCapabilitiesSchema = z
  .array(modelCapabilitySchema)
  .max(modelCapabilityValues.length)
  .refine((items) => new Set(items).size === items.length, "Expected unique model capabilities");

export const credentialReferenceSchema = boundedUnicodeStringSchema({
  minLength: 1,
  maxLength: 256,
}).refine((value) => {
  return [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return !/\s/u.test(character) && code >= 32 && code !== 127;
  });
}, "Expected a credential reference without whitespace or control characters");

export const httpBaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.hash === ""
      );
    } catch {
      return false;
    }
  }, "Expected an HTTP(S) base URL without credentials or fragments");

const runtimeConnectionShape = {
  id: opaqueIdSchema,
  name: boundedUnicodeStringSchema({ minLength: 1, maxLength: 120 }),
  credential_ref: credentialReferenceSchema.nullable(),
  timeout_ms: z.number().int().positive().max(600_000),
  max_retries: z.number().int().min(0).max(10),
} as const;

export const runtimeCallConnectionSchema = z.discriminatedUnion("driver", [
  z.strictObject({
    ...runtimeConnectionShape,
    driver: z.literal("litellm"),
    base_url: httpBaseUrlSchema,
  }),
  z.strictObject({
    ...runtimeConnectionShape,
    driver: z.literal("openai_compatible"),
    base_url: httpBaseUrlSchema,
  }),
  z.strictObject({
    ...runtimeConnectionShape,
    driver: z.literal("anthropic"),
    base_url: httpBaseUrlSchema.nullable(),
    api_version: boundedUnicodeStringSchema({ minLength: 1, maxLength: 64 }).nullable(),
  }),
]);

export type CallConnectionDriver = z.infer<typeof callConnectionDriverSchema>;
export type CallConnectionStatus = z.infer<typeof callConnectionStatusSchema>;
export type ModelTaskType = z.infer<typeof modelTaskTypeSchema>;
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;
export type RuntimeCallConnection = z.infer<typeof runtimeCallConnectionSchema>;

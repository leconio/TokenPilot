import { callConnectionDriverValues, httpBaseUrlSchema } from "@tokenpilot/contracts";
import { z } from "zod";

const nameSchema = z.string().trim().min(1).max(120);
const credentialReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => {
    return [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return !/\s/u.test(character) && code >= 32 && code !== 127;
    });
  }, "Expected a credential reference without whitespace or control characters");

const publicConfigSchema = z.strictObject({
  timeout_ms: z.number().int().positive().max(600_000).optional(),
  max_retries: z.number().int().min(0).max(10).optional(),
  api_version: z.string().trim().min(1).max(64).optional(),
});

const connectionShape = {
  name: nameSchema,
  driver: z.enum(callConnectionDriverValues),
  base_url: httpBaseUrlSchema.nullable().optional(),
  credential_ref: credentialReferenceSchema.nullable().optional(),
  public_config: publicConfigSchema.optional(),
  connector_instance_id: z.string().uuid().nullable().optional(),
} as const;

function validateDriver(
  value: {
    driver: (typeof callConnectionDriverValues)[number];
    base_url?: string | null | undefined;
    connector_instance_id?: string | null | undefined;
    public_config?: { api_version?: string | undefined } | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (
    (value.driver === "litellm" || value.driver === "openai_compatible") &&
    value.base_url == null
  ) {
    context.addIssue({
      code: "custom",
      path: ["base_url"],
      message: "This connection type requires a base URL",
    });
  }
  if (value.driver !== "litellm" && value.connector_instance_id != null) {
    context.addIssue({
      code: "custom",
      path: ["connector_instance_id"],
      message: "Only a LiteLLM connection can bind a connector instance",
    });
  }
  if (value.driver !== "anthropic" && value.public_config?.api_version !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["public_config", "api_version"],
      message: "api_version is only available for Anthropic connections",
    });
  }
}

export const createConnectionSchema = z.strictObject(connectionShape).superRefine(validateDriver);

export const updateConnectionSchema = z
  .strictObject({
    name: nameSchema.optional(),
    driver: z.enum(callConnectionDriverValues).optional(),
    base_url: httpBaseUrlSchema.nullable().optional(),
    credential_ref: credentialReferenceSchema.nullable().optional(),
    public_config: publicConfigSchema.optional(),
    connector_instance_id: z.string().uuid().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Expected at least one change");

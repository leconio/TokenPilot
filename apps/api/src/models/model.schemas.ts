import { modelCapabilitiesSchema, modelTaskTypeSchema } from "@tokenpilot/contracts";
import { z } from "zod";

const modelNameSchema = z.string().trim().min(1).max(120);
const requestModelSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return !/\s/u.test(character) && code >= 32 && code !== 127;
      }),
    "Expected a model identifier without whitespace or control characters",
  );
const providerSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u, "Expected a normalized provider key");

export const createModelSchema = z.strictObject({
  name: modelNameSchema,
  connection_id: z.string().uuid(),
  request_model: requestModelSchema,
  provider: providerSchema,
  task_type: modelTaskTypeSchema,
  capabilities: modelCapabilitiesSchema.optional(),
  notes: z.string().trim().max(2_000).nullable().optional(),
});

export const updateModelSchema = z
  .strictObject({
    name: modelNameSchema.optional(),
    connection_id: z.string().uuid().optional(),
    request_model: requestModelSchema.optional(),
    provider: providerSchema.optional(),
    task_type: modelTaskTypeSchema.optional(),
    capabilities: modelCapabilitiesSchema.optional(),
    notes: z.string().trim().max(2_000).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Expected at least one change");

export const listModelsSchema = z.strictObject({
  provider: providerSchema.optional(),
  connection_id: z.string().uuid().optional(),
  task_type: modelTaskTypeSchema.optional(),
  enabled: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

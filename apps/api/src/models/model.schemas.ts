import { z } from "zod";

const modelName = z.string().trim().min(1).max(120);
const litellmTag = z
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
    "Expected a LiteLLM model tag without whitespace or control characters",
  );
const capabilities = z
  .array(
    z.enum([
      "chat",
      "embedding",
      "vision",
      "audio_input",
      "audio_output",
      "tools",
      "structured_output",
      "reasoning",
    ]),
  )
  .max(8)
  .refine((items) => new Set(items).size === items.length, "Capabilities must be unique");

export const createModelSchema = z.strictObject({
  name: modelName,
  litellm_tag: litellmTag,
  provider: z.string().trim().min(1).max(120).nullable().optional(),
  capabilities: capabilities.optional(),
  notes: z.string().trim().max(2_000).nullable().optional(),
});

export const updateModelSchema = z
  .strictObject({
    name: modelName.optional(),
    litellm_tag: litellmTag.optional(),
    provider: z.string().trim().min(1).max(120).nullable().optional(),
    capabilities: capabilities.optional(),
    notes: z.string().trim().max(2_000).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Expected at least one change");

import { z } from "zod";

import { modelTaskTypeSchema, virtualModelRouteMatchSchema } from "@tokenpilot/contracts";

const stableName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);

export const createVirtualModelSchema = z.strictObject({
  name: stableName,
  display_name: z.string().trim().min(1).max(120).optional(),
  task_type: modelTaskTypeSchema,
  default_model_id: z.string().uuid().nullable().optional(),
});

export const updateVirtualModelSchema = z
  .strictObject({
    display_name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2_000).nullable().optional(),
    task_type: modelTaskTypeSchema.optional(),
    default_model_id: z.string().uuid().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Expected at least one change");

export const createVirtualModelTargetSchema = z.strictObject({
  model_id: z.string().uuid(),
  priority: z.number().int().min(0).max(10_000).optional(),
  weight: z.number().positive().max(1_000).optional(),
});

export const updateVirtualModelTargetSchema = z.strictObject({
  weight: z.number().positive().max(1_000),
});

export const reorderVirtualModelTargetsSchema = z.strictObject({
  ordered_target_ids: z
    .array(z.string().uuid())
    .min(1)
    .max(64)
    .refine((ids) => new Set(ids).size === ids.length, "Target IDs must be unique"),
});

export const createVirtualModelRuleSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    target_model_id: z.string().uuid(),
    priority: z.number().int().min(0).max(10_000).optional(),
    match: virtualModelRouteMatchSchema,
    expires_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .superRefine((value, context) => {
    if ("override_active" in value.match && !value.expires_at) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "A temporary route requires an expiry",
      });
    }
  });

export const updateVirtualModelRuleSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    target_model_id: z.string().uuid().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    match: virtualModelRouteMatchSchema.optional(),
    expires_at: z.string().datetime({ offset: true }).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Expected at least one change");

export const simulateVirtualModelSchema = z.strictObject({
  instant: z.string().datetime({ offset: true }),
  user_id: z.string().trim().min(1).max(256).optional(),
  user_properties: z
    .record(
      z.string().min(1).max(128),
      z.union([z.string().max(2_048), z.number().finite().safe(), z.boolean()]),
    )
    .optional(),
  call_source: z.string().trim().min(1).max(120).optional(),
});

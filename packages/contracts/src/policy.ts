import { z } from "zod";

import { routeTagSchema, utcDateTimeSchema } from "./common.js";

const clockTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM");

const scheduleSchema = z.strictObject({
  days: z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .max(7)
    .refine((days) => new Set(days).size === days.length, "Schedule days must be unique"),
  from: clockTimeSchema,
  to: clockTimeSchema,
});

const propertyValueSchema = z.union([
  z.string().max(2_048),
  z.number().finite().safe(),
  z.boolean(),
]);

const userPropertyMatchSchema = z
  .strictObject({
    key: z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/u),
    operator: z.enum(["equals", "not_equals", "contains", "starts_with", "is_set", "is_not_set"]),
    value: propertyValueSchema.optional(),
  })
  .superRefine((match, context) => {
    if (
      match.operator !== "is_set" &&
      match.operator !== "is_not_set" &&
      match.value === undefined
    ) {
      context.addIssue({ code: "custom", path: ["value"], message: "Expected a value" });
    }
  });

export const runtimeRouteMatchSchema = z.union([
  z.strictObject({ override_active: z.literal(true) }),
  z.strictObject({ schedule: scheduleSchema }),
  z.strictObject({
    user: z.strictObject({
      ids: z.array(z.string().min(1).max(256)).max(50_000),
    }),
  }),
  z.strictObject({ user_property: userPropertyMatchSchema }),
  z.strictObject({
    call_source: z.strictObject({ value: z.string().trim().min(1).max(120) }),
  }),
]);

export const virtualModelRouteMatchSchema = z.union([
  runtimeRouteMatchSchema,
  z.strictObject({
    user_group: z.strictObject({ group_id: z.string().uuid() }),
  }),
  z.strictObject({
    user_tag: z.strictObject({ value: z.string().trim().min(1).max(64) }),
  }),
  z.strictObject({
    aiu_state: z.strictObject({
      value: z.enum(["available", "low", "exhausted", "unlimited"]),
    }),
  }),
]);

export const virtualModelRoutingRuleSchema = z
  .strictObject({
    id: z.string().min(1).max(120),
    priority: z.number().int(),
    match: virtualModelRouteMatchSchema,
    route_tag: routeTagSchema,
    expires_at: utcDateTimeSchema.optional(),
  })
  .superRefine((rule, context) => {
    if ("override_active" in rule.match && rule.expires_at === undefined) {
      context.addIssue({
        code: "custom",
        message: "An override rule requires expires_at",
        path: ["expires_at"],
      });
    }
  });

export type RuntimeRouteMatch = z.infer<typeof runtimeRouteMatchSchema>;
export type VirtualModelRouteMatch = z.infer<typeof virtualModelRouteMatchSchema>;
export type VirtualModelRoutingRule = z.infer<typeof virtualModelRoutingRuleSchema>;

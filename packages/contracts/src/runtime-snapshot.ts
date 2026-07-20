import { z } from "zod";

import { routeTagSchema, virtualModelNameSchema } from "./common.js";
import { runtimeRouteMatchSchema } from "./policy.js";
import {
  aiuModeSchema,
  boundedUnicodeStringSchema,
  dimensionKeySchema,
  opaqueIdSchema,
  sha256FingerprintSchema,
  utcTimestampSchema,
} from "./primitives.js";

const governedKeysSchema = z
  .array(dimensionKeySchema)
  .max(256)
  .refine((keys) => new Set(keys).size === keys.length, "Expected unique dimension keys");

export const runtimeRouteTargetSchema = z.strictObject({
  model_id: opaqueIdSchema,
  model_tag: boundedUnicodeStringSchema({ minLength: 1, maxLength: 256 }),
  provider: boundedUnicodeStringSchema({ minLength: 1, maxLength: 120 }).optional(),
  route_tag: routeTagSchema,
  fallback_order: z.number().int().safe().min(0).max(63),
  weight: z.union([
    z.number().int().positive().max(1_000),
    z.number().finite().positive().max(1_000),
  ]),
});

export const runtimeRouteSchema = z
  .strictObject({
    route_tag: routeTagSchema,
    selection_mode: z.enum(["ordered", "weighted"]),
    targets: z.array(runtimeRouteTargetSchema).min(1).max(64),
  })
  .superRefine((route, context) => {
    const modelIds = route.targets.map((target) => target.model_id);
    if (new Set(modelIds).size !== modelIds.length) {
      context.addIssue({
        code: "custom",
        path: ["targets"],
        message: "Expected unique model IDs within a route",
      });
    }
    route.targets.forEach((target, index) => {
      if (target.route_tag !== route.route_tag) {
        context.addIssue({
          code: "custom",
          path: ["targets", index, "route_tag"],
          message: "Target route tag must match its route",
        });
      }
      if (target.fallback_order !== index) {
        context.addIssue({
          code: "custom",
          path: ["targets", index, "fallback_order"],
          message: "Targets must use a contiguous zero-based fallback order",
        });
      }
    });
  });

export const runtimeRoutingRuleSchema = z
  .strictObject({
    id: boundedUnicodeStringSchema({ minLength: 1, maxLength: 120 }),
    priority: z.number().int().safe(),
    match: runtimeRouteMatchSchema,
    route: runtimeRouteSchema,
    expires_at: utcTimestampSchema.optional(),
  })
  .superRefine((rule, context) => {
    if ("override_active" in rule.match && rule.expires_at === undefined) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "An override rule requires expires_at",
      });
    }
  });

export const runtimeRoutingPlanSchema = z
  .strictObject({
    virtual_model_id: opaqueIdSchema,
    configuration_version: z.number().int().positive(),
    configuration_etag: sha256FingerprintSchema,
    published_at: utcTimestampSchema,
    timezone: boundedUnicodeStringSchema({ minLength: 1, maxLength: 128 }),
    default: runtimeRouteSchema,
    rules: z.array(runtimeRoutingRuleSchema).max(512),
  })
  .superRefine((plan, context) => {
    const ruleIds = plan.rules.map((rule) => rule.id);
    if (new Set(ruleIds).size !== ruleIds.length) {
      context.addIssue({ code: "custom", path: ["rules"], message: "Rule IDs must be unique" });
    }
  });

export const runtimeSnapshotSchema = z
  .strictObject({
    schema_version: z.literal("2.0"),
    application_id: z.string().uuid(),
    version: opaqueIdSchema,
    etag: sha256FingerprintSchema,
    signature: sha256FingerprintSchema,
    expires_at: utcTimestampSchema,
    routing: z.record(virtualModelNameSchema, runtimeRoutingPlanSchema),
    aiu: z.strictObject({
      enabled: z.boolean(),
      mode: aiuModeSchema,
      unrated_model_policy: z.enum([
        "allow_unrated",
        "block_unrated",
        "fallback_required",
        "alert_only",
      ]),
    }),
    access: z.strictObject({
      application_enabled: z.boolean(),
      blocked_user_ids: z
        .array(boundedUnicodeStringSchema({ minLength: 1, maxLength: 256 }))
        .max(50_000)
        .refine((ids) => new Set(ids).size === ids.length, "Expected unique blocked user IDs"),
    }),
    dimensions: z.strictObject({
      analytics_allowed_keys: governedKeysSchema,
    }),
  })
  .superRefine((snapshot, context) => {
    const configurationVersions = new Set(
      Object.values(snapshot.routing).map((plan) => plan.configuration_version),
    );
    if (configurationVersions.size > 1) {
      context.addIssue({
        code: "custom",
        path: ["routing"],
        message: "All routing plans must belong to one configuration version",
      });
    }
    if (snapshot.aiu.mode === "disabled" && snapshot.aiu.enabled) {
      context.addIssue({
        code: "custom",
        path: ["aiu", "mode"],
        message: "enabled AIU requires an active mode",
      });
    }
    if (snapshot.aiu.mode !== "disabled" && !snapshot.aiu.enabled) {
      context.addIssue({
        code: "custom",
        path: ["aiu", "enabled"],
        message: "an active AIU mode requires enabled=true",
      });
    }
  })
  .meta({
    id: "RuntimeSnapshot",
    title: "Runtime Snapshot",
    description: "ETag-addressed runtime configuration used by trusted SDKs and connectors.",
  });

const runtimeUserPropertyValueSchema = z.union([
  z.string().max(2_048),
  z.number().finite().safe(),
  z.boolean(),
  z.array(z.string().max(256)).max(32),
]);
const runtimeUserPropertyKeySchema = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/u);
const runtimeAiuMicrosSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/u)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);

export const runtimeUserReservationRequestSchema = z.strictObject({
  user_id: boundedUnicodeStringSchema({ minLength: 1, maxLength: 256 }),
  display_user: boundedUnicodeStringSchema({ minLength: 1, maxLength: 256 }).optional(),
  user_properties: z
    .record(runtimeUserPropertyKeySchema, runtimeUserPropertyValueSchema)
    .optional(),
  operation_id: opaqueIdSchema,
  virtual_model: virtualModelNameSchema,
  candidate_model_ids: z
    .array(z.string().uuid())
    .min(1)
    .max(32)
    .refine((ids) => new Set(ids).size === ids.length, "Expected unique model IDs")
    .optional(),
  estimated_aiu_micros: runtimeAiuMicrosSchema,
});

const runtimeUserQuotaSummarySchema = z.strictObject({
  id: opaqueIdSchema,
  limit_aiu_micros: runtimeAiuMicrosSchema.nullable(),
  used_aiu_micros: runtimeAiuMicrosSchema,
  reserved_aiu_micros: runtimeAiuMicrosSchema,
  remaining_aiu_micros: runtimeAiuMicrosSchema.nullable(),
});

export const runtimeUserReservationResponseSchema = z
  .strictObject({
    allowed: z.boolean(),
    reason: boundedUnicodeStringSchema({ minLength: 1, maxLength: 120 }),
    user: runtimeUserQuotaSummarySchema,
    reservation: z
      .strictObject({
        id: opaqueIdSchema,
        token: boundedUnicodeStringSchema({ minLength: 64, maxLength: 4_096 }),
        reserved_aiu_micros: runtimeAiuMicrosSchema,
        expires_at: utcTimestampSchema,
      })
      .nullable(),
  })
  .superRefine((response, context) => {
    if (!response.allowed && response.reservation !== null) {
      context.addIssue({
        code: "custom",
        path: ["reservation"],
        message: "A denied request cannot include a reservation",
      });
    }
  });

export const runtimeUserReservationSettlementSchema = z.strictObject({
  reservation_token: boundedUnicodeStringSchema({ minLength: 64, maxLength: 4_096 }),
  settled_aiu_micros: runtimeAiuMicrosSchema,
});

export const runtimeUserReservationReleaseSchema = z.strictObject({
  reservation_token: boundedUnicodeStringSchema({ minLength: 64, maxLength: 4_096 }),
  reason: boundedUnicodeStringSchema({ minLength: 1, maxLength: 500 }),
});

export type RuntimeSnapshot = z.infer<typeof runtimeSnapshotSchema>;
export type RuntimeRouteTarget = z.infer<typeof runtimeRouteTargetSchema>;
export type RuntimeRoute = z.infer<typeof runtimeRouteSchema>;
export type RuntimeRoutingRule = z.infer<typeof runtimeRoutingRuleSchema>;
export type RuntimeRoutingPlan = z.infer<typeof runtimeRoutingPlanSchema>;
export type RuntimeUserReservationRequest = z.infer<typeof runtimeUserReservationRequestSchema>;
export type RuntimeUserReservationResponse = z.infer<typeof runtimeUserReservationResponseSchema>;
export type RuntimeUserReservationSettlement = z.infer<
  typeof runtimeUserReservationSettlementSchema
>;
export type RuntimeUserReservationRelease = z.infer<typeof runtimeUserReservationReleaseSchema>;

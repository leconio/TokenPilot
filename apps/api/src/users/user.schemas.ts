import { z } from "zod";

const aiu = z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/u);
const tokenQuantity = z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/u);
const propertyKey = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9._-]{0,127}$/u);
const propertyValue = z.union([
  z.string().max(2_048),
  z.number().finite().safe(),
  z.boolean(),
  z.array(z.string().max(256)).max(32),
]);

export const createUserSchema = z.strictObject({
  user_id: z.string().trim().min(1).max(256),
  display_user: z.string().trim().min(1).max(256).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
  properties: z.record(z.string().min(1).max(128), propertyValue).default({}),
});

export const listUsersSchema = z
  .strictObject({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(25),
    search: z.string().trim().max(256).optional(),
    status: z.enum(["active", "blocked"]).optional(),
    tag: z.string().trim().min(1).max(64).optional(),
    group_id: z.string().uuid().optional(),
    min_calls: z.coerce.number().int().min(0).optional(),
    min_tokens: tokenQuantity.optional(),
    min_aiu: aiu.optional(),
    property_key: propertyKey.optional(),
    property_value: z.string().trim().min(1).max(2_048).optional(),
  })
  .superRefine((value, context) => {
    if ((value.property_key === undefined) !== (value.property_value === undefined)) {
      context.addIssue({
        code: "custom",
        path: [value.property_key === undefined ? "property_key" : "property_value"],
        message: "A user field and value must be provided together",
      });
    }
  });

export const updateUserSchema = z
  .strictObject({
    display_user: z.string().trim().min(1).max(256).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
    blocked: z.boolean().optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .refine((value) => value.blocked !== true || value.reason !== undefined, {
    message: "Blocking a user requires a reason",
  });

export const saveUserQuotaSchema = z
  .strictObject({
    limit: aiu,
    hard_limit: z.boolean().default(false),
    period: z.enum(["day", "week", "month", "fixed", "lifetime"]).default("lifetime"),
    starts_at: z.string().datetime({ offset: true }).optional(),
    ends_at: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((value, context) => {
    if (value.period === "fixed") {
      if (
        value.starts_at === undefined ||
        value.ends_at === undefined ||
        value.starts_at >= value.ends_at
      ) {
        context.addIssue({
          code: "custom",
          path: ["ends_at"],
          message: "Fixed quota requires a valid time range",
        });
      }
    } else if (value.starts_at !== undefined || value.ends_at !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["starts_at"],
        message: "Only a fixed quota accepts a time range",
      });
    }
  });

export const resetUserQuotaSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});

export const userAnalyticsRangeSchema = z.strictObject({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

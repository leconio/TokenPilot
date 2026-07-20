import { z } from "zod";

const scalar = z.union([z.string().max(2_048), z.number().finite().safe(), z.boolean()]);
const conditionValue = z.union([
  scalar,
  z.array(scalar).min(1).max(100),
  z.strictObject({ min: scalar.optional(), max: scalar.optional() }),
]);

export const userGroupFieldValues = [
  "user_id",
  "display_user",
  "tag",
  "status",
  "property",
  "last_seen_at",
  "calls",
  "tokens",
  "aiu",
  "cost",
  "remaining_aiu",
] as const;

export const userGroupOperatorValues = [
  "equals",
  "not_equals",
  "contains",
  "starts_with",
  "is_set",
  "is_not_set",
  "one_of",
  "greater_than",
  "at_least",
  "less_than",
  "at_most",
  "between",
] as const;

const conditionSchema = z
  .strictObject({
    field: z.enum(userGroupFieldValues),
    operator: z.enum(userGroupOperatorValues),
    property: z
      .string()
      .regex(/^[a-z][a-z0-9._-]{0,127}$/u)
      .optional(),
    value: conditionValue.optional(),
  })
  .superRefine((condition, context) => {
    if (condition.field === "property" && condition.property === undefined) {
      context.addIssue({ code: "custom", path: ["property"], message: "Select a user property" });
    }
    if (
      condition.operator !== "is_set" &&
      condition.operator !== "is_not_set" &&
      condition.value === undefined
    ) {
      context.addIssue({ code: "custom", path: ["value"], message: "Enter a comparison value" });
    }
  });

export const userGroupDefinitionSchema = z.strictObject({
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(conditionSchema).min(1).max(20),
});

export const createUserGroupSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500).optional(),
  definition: userGroupDefinitionSchema,
  refresh_minutes: z.number().int().min(5).max(10_080).nullable().optional(),
});

export const updateUserGroupSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().min(1).max(500).nullable().optional(),
    definition: userGroupDefinitionSchema.optional(),
    refresh_minutes: z.number().int().min(5).max(10_080).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Enter at least one change");

export const previewUserGroupSchema = z.strictObject({
  definition: userGroupDefinitionSchema,
  limit: z.number().int().min(1).max(100).default(20),
});

export const userGroupBulkActionSchema = z.strictObject({
  action: z.enum(["quota_reset", "block", "unblock"]),
  reason: z.string().trim().min(1).max(500),
});

export type UserGroupDefinition = z.infer<typeof userGroupDefinitionSchema>;
export type UserGroupCondition = UserGroupDefinition["conditions"][number];

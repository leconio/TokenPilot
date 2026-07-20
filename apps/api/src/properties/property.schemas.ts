import { z } from "zod";

const propertyKey = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9._-]{0,127}$/u);
const displayName = z.string().trim().min(1).max(120);
const dataType = z.enum(["TEXT", "NUMBER", "BOOLEAN", "DATETIME", "ENUM", "TEXT_LIST"]);
type PropertyDataTypeInput = z.infer<typeof dataType>;
const allowedValues = z
  .array(z.string().trim().min(1).max(256))
  .min(1)
  .max(100)
  .refine((values) => new Set(values).size === values.length, "Values must be unique");
export const propertyConstraintsSchema = z
  .strictObject({
    max_length: z.number().int().min(1).max(2_048).optional(),
    min: z.number().finite().safe().optional(),
    max: z.number().finite().safe().optional(),
    max_items: z.number().int().min(1).max(32).optional(),
  })
  .superRefine((value, context) => {
    if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
      context.addIssue({
        code: "custom",
        path: ["max"],
        message: "Maximum must not be below minimum",
      });
    }
  });

export function constraintsMatchType(
  dataType: PropertyDataTypeInput,
  constraints: z.infer<typeof propertyConstraintsSchema>,
): boolean {
  if ((constraints.min !== undefined || constraints.max !== undefined) && dataType !== "NUMBER") {
    return false;
  }
  if (constraints.max_items !== undefined && dataType !== "TEXT_LIST") return false;
  return constraints.max_length === undefined || dataType === "TEXT" || dataType === "TEXT_LIST";
}

export const createPropertySchema = z
  .strictObject({
    key: propertyKey,
    display_name: displayName,
    scope: z.enum(["EVENT", "USER"]),
    data_type: dataType,
    allowed_values: allowedValues.optional(),
    constraints: propertyConstraintsSchema.optional(),
    searchable: z.boolean().optional(),
    groupable: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    confirm_high_cardinality: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (value.data_type === "ENUM" && value.allowed_values === undefined) {
      context.addIssue({
        code: "custom",
        message: "Enum fields require allowed values",
        path: ["allowed_values"],
      });
    }
    if (value.data_type !== "ENUM" && value.allowed_values !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Allowed values are only available for enum fields",
        path: ["allowed_values"],
      });
    }
    if (
      value.constraints !== undefined &&
      !constraintsMatchType(value.data_type, value.constraints)
    ) {
      context.addIssue({
        code: "custom",
        message: "These limits do not match the selected field type",
        path: ["constraints"],
      });
    }
    if (
      value.groupable === true &&
      ["TEXT", "DATETIME", "TEXT_LIST"].includes(value.data_type) &&
      value.confirm_high_cardinality !== true
    ) {
      context.addIssue({
        code: "custom",
        message: "Confirm the grouping-cardinality risk",
        path: ["confirm_high_cardinality"],
      });
    }
    if (value.groupable === true && value.data_type === "TEXT_LIST") {
      context.addIssue({
        code: "custom",
        message: "Text-list fields cannot be used for grouping",
        path: ["groupable"],
      });
    }
  });

export const updatePropertySchema = z
  .strictObject({
    display_name: displayName.optional(),
    allowed_values: allowedValues.optional(),
    constraints: propertyConstraintsSchema.optional(),
    searchable: z.boolean().optional(),
    groupable: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Expected at least one change");

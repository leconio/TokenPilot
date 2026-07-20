import { z } from "zod";

import {
  reportFilterConditionSchema,
  reportGroupDimensionSchema,
  reportMetricSchema,
} from "@tokenpilot/contracts";

const nameSchema = z.string().trim().min(1).max(120);
const propertyKeySchema = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/u);

const reportGroupSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("builtin"),
    dimension: reportGroupDimensionSchema.exclude(["property"]),
  }),
  z.strictObject({
    kind: z.literal("property"),
    scope: z.enum(["event", "user"]),
    key: propertyKeySchema,
  }),
]);

export const savedReportDefinitionSchema = z.strictObject({
  version: z.literal(1),
  range: z.enum(["24h", "7d", "30d", "90d"]),
  metric: reportMetricSchema,
  filter_match: z.enum(["all", "any"]),
  conditions: z.array(reportFilterConditionSchema).max(64),
  group: reportGroupSchema,
  grain: z.enum(["hour", "day", "week", "month"]),
});

export const createSavedReportSchema = z
  .strictObject({
    name: nameSchema,
    kind: z.enum(["usage", "cost", "aiu"]),
    definition: savedReportDefinitionSchema,
  })
  .superRefine((report, context) => {
    const expected =
      report.kind === "cost"
        ? ["provider_cost"]
        : report.kind === "aiu"
          ? ["aiu"]
          : ["requests", "tokens", "unique_users", "success_rate", "average_latency"];
    if (!expected.includes(report.definition.metric)) {
      context.addIssue({
        code: "custom",
        path: ["definition", "metric"],
        message: "The selected metric does not match the report type",
      });
    }
  });

export const updateSavedReportSchema = z
  .strictObject({
    name: nameSchema.optional(),
    definition: savedReportDefinitionSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Expected at least one change");

export const createDashboardCardSchema = z.strictObject({
  report_id: z.string().uuid(),
  width: z.number().int().min(1).max(2).optional(),
});

export const updateDashboardCardSchema = z
  .strictObject({
    position: z.number().int().min(0).max(99).optional(),
    width: z.number().int().min(1).max(2).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Expected at least one change");

export type SavedReportDefinition = z.infer<typeof savedReportDefinitionSchema>;

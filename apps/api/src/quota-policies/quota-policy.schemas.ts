import { z } from "zod";

const aiu = z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/u);

export const saveQuotaPolicySchema = z
  .strictObject({
    limit: aiu,
    hard_limit: z.boolean().default(false),
    period: z.enum(["day", "week", "month", "fixed", "lifetime"]).default("lifetime"),
    starts_at: z.iso.datetime({ offset: true }).optional(),
    ends_at: z.iso.datetime({ offset: true }).optional(),
    priority: z.number().int().min(0).max(10_000).default(0),
    reason: z.string().trim().min(1).max(500).default("Updated AIU quota rule"),
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

export const disableQuotaPolicySchema = z.strictObject({
  reason: z.string().trim().min(1).max(500).default("Removed AIU quota rule"),
});

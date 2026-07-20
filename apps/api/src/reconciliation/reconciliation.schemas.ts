import { z } from "zod";

const rangeFields = {
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
} as const;

export const createRunSchema = z.strictObject({
  type: z.enum(["hourly", "daily", "manual"]).default("hourly"),
  ...rangeFields,
  virtual_model: z.string().min(1).max(120).optional(),
  model_id: z.string().uuid().optional(),
  user_id: z.string().min(1).max(256).optional(),
  reason: z.string().min(5).max(500),
});

export const listSchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  page_size: z.coerce.number().int().min(1).max(200).optional(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]).optional(),
  run_id: z.string().uuid().optional(),
});

export const diffListSchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  page_size: z.coerce.number().int().min(1).max(200).optional(),
  run_id: z.string().uuid().optional(),
  status: z.enum(["open", "investigating", "resolved", "ignored"]).optional(),
  severity: z.enum(["info", "warning", "error", "critical"]).optional(),
});

export const replaySchema = z.strictObject({
  mode: z.enum(["dry_run", "execute"]).default("dry_run"),
  reason: z.string().min(5).max(500),
});

export const resolveSchema = z.strictObject({
  resolution: z.enum(["official_confirmed", "false_positive", "corrected", "ignored"]),
  note: z.string().min(5).max(500),
});

export const rebuildSchema = z.strictObject({
  mode: z.literal("fresh_rebuild"),
  reason: z.string().min(5).max(500),
});

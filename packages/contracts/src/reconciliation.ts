import { z } from "zod";

import { compareUtcDateTimes } from "./common.js";
import {
  boundedUnicodeStringSchema,
  decimal38_18Schema,
  eventIdSchema,
  microAiuStringSchema,
  opaqueIdSchema,
  signedDecimal38_18Schema,
  signedMicroAiuStringSchema,
  utcTimestampSchema,
} from "./primitives.js";

export const reconciliationRunTypeValues = [
  "hourly",
  "daily",
  "manual",
  "rebuild",
  "unknown",
] as const;
export const reconciliationRunStatusValues = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "unknown",
] as const;
export const reconciliationDiffTypeValues = [
  "CH_MISSING",
  "PG_MISSING",
  "DUPLICATE_PROJECTION",
  "PAYLOAD_HASH_CONFLICT",
  "USAGE_NORMALIZATION_MISMATCH",
  "MODEL_IDENTITY_MISMATCH",
  "PRICE_VERSION_MISMATCH",
  "AIU_RATE_VERSION_MISMATCH",
  "PROVISIONAL_OFFICIAL_DELTA_PENDING",
  "LEDGER_PROJECTION_MISSING",
  "LATE_EVENT",
  "ADJUSTMENT_NOT_PROJECTED",
  "WATERMARK_STALLED",
  "unknown",
] as const;
export const reconciliationSeverityValues = [
  "info",
  "warning",
  "error",
  "critical",
  "unknown",
] as const;
export const reconciliationDiffStatusValues = [
  "open",
  "investigating",
  "resolved",
  "ignored",
  "unknown",
] as const;
export const reconciliationGranularityValues = ["hour", "day", "unknown"] as const;

export const reconciliationRunTypeSchema = z.enum(reconciliationRunTypeValues).meta({
  id: "ReconciliationRunType",
});
export const reconciliationRunStatusSchema = z.enum(reconciliationRunStatusValues).meta({
  id: "ReconciliationRunStatus",
});
export const reconciliationDiffTypeSchema = z.enum(reconciliationDiffTypeValues).meta({
  id: "ReconciliationDiffType",
});
export const reconciliationSeveritySchema = z.enum(reconciliationSeverityValues).meta({
  id: "ReconciliationSeverity",
});
export const reconciliationDiffStatusSchema = z.enum(reconciliationDiffStatusValues).meta({
  id: "ReconciliationDiffStatus",
});
export const reconciliationGranularitySchema = z.enum(reconciliationGranularityValues).meta({
  id: "ReconciliationGranularity",
});

const nonNegativeMetricShape = {
  event_count: microAiuStringSchema.optional(),
  input_tokens: microAiuStringSchema.optional(),
  cached_input_tokens: microAiuStringSchema.optional(),
  output_tokens: microAiuStringSchema.optional(),
  provider_cost: decimal38_18Schema.optional(),
  aiu_micros: microAiuStringSchema.optional(),
  unpriced_count: microAiuStringSchema.optional(),
  unrated_count: microAiuStringSchema.optional(),
};

const signedMetricShape = {
  event_count: signedMicroAiuStringSchema.optional(),
  input_tokens: signedMicroAiuStringSchema.optional(),
  cached_input_tokens: signedMicroAiuStringSchema.optional(),
  output_tokens: signedMicroAiuStringSchema.optional(),
  provider_cost: signedDecimal38_18Schema.optional(),
  aiu_micros: signedMicroAiuStringSchema.optional(),
  unpriced_count: signedMicroAiuStringSchema.optional(),
  unrated_count: signedMicroAiuStringSchema.optional(),
};

export const reconciliationMetricValuesSchema = z
  .strictObject(nonNegativeMetricShape)
  .refine((values) => Object.keys(values).length > 0, "Expected at least one metric value")
  .meta({ id: "ReconciliationMetricValues" });

export const reconciliationDeltaValuesSchema = z
  .strictObject(signedMetricShape)
  .meta({ id: "ReconciliationDeltaValues" });

export const reconciliationRunSummarySchema = z
  .strictObject({
    event_count: microAiuStringSchema,
    input_tokens: microAiuStringSchema,
    cached_input_tokens: microAiuStringSchema,
    output_tokens: microAiuStringSchema,
    provider_cost: decimal38_18Schema,
    aiu_micros: microAiuStringSchema,
    unpriced_count: microAiuStringSchema,
    unrated_count: microAiuStringSchema,
    diff_count: microAiuStringSchema,
  })
  .meta({ id: "ReconciliationRunSummary" });

export const reconciliationDimensionsSchema = z
  .strictObject({
    application_id: opaqueIdSchema,
    granularity: reconciliationGranularitySchema,
    time_bucket: utcTimestampSchema,
    virtual_model: boundedUnicodeStringSchema({ minLength: 1, maxLength: 120 }).nullable(),
    model_id: opaqueIdSchema.nullable(),
    model_tag: boundedUnicodeStringSchema({ minLength: 1, maxLength: 256 }).nullable(),
    provider: boundedUnicodeStringSchema({ minLength: 1, maxLength: 120 }).nullable(),
    user_id: boundedUnicodeStringSchema({ minLength: 1, maxLength: 256 }).nullable(),
  })
  .meta({ id: "ReconciliationDimensions" });

export const reconciliationRunSchema = z
  .strictObject({
    id: opaqueIdSchema,
    application_id: opaqueIdSchema,
    run_type: reconciliationRunTypeSchema,
    range_start: utcTimestampSchema,
    range_end: utcTimestampSchema,
    status: reconciliationRunStatusSchema,
    pg_watermark: utcTimestampSchema.nullable(),
    ch_watermark: utcTimestampSchema.nullable(),
    summary: reconciliationRunSummarySchema,
    started_by: opaqueIdSchema.nullable(),
    started_at: utcTimestampSchema,
    finished_at: utcTimestampSchema.nullable(),
    error: boundedUnicodeStringSchema({ minLength: 1, maxLength: 2000 }).nullable(),
  })
  .superRefine((run, context) => {
    if (compareUtcDateTimes(run.range_start, run.range_end) >= 0) {
      context.addIssue({
        code: "custom",
        message: "range_end must be later than range_start",
        path: ["range_end"],
      });
    }

    if (run.status === "running" && run.finished_at !== null) {
      context.addIssue({
        code: "custom",
        message: "A running reconciliation cannot have finished_at",
        path: ["finished_at"],
      });
    }
    if (
      (run.status === "completed" || run.status === "failed" || run.status === "cancelled") &&
      run.finished_at === null
    ) {
      context.addIssue({
        code: "custom",
        message: `${run.status} requires finished_at`,
        path: ["finished_at"],
      });
    }
    if (run.status === "failed" && run.error === null) {
      context.addIssue({
        code: "custom",
        message: "A failed reconciliation requires an error",
        path: ["error"],
      });
    }
  })
  .meta({
    id: "ReconciliationRun",
    title: "Reconciliation Run",
    description: "A bounded comparison of PostgreSQL official and ClickHouse projected data.",
  });

export const reconciliationDiffSchema = z
  .strictObject({
    id: opaqueIdSchema,
    run_id: opaqueIdSchema,
    diff_type: reconciliationDiffTypeSchema,
    severity: reconciliationSeveritySchema,
    dimensions: reconciliationDimensionsSchema.nullable(),
    pg_values: reconciliationMetricValuesSchema.nullable(),
    ch_values: reconciliationMetricValuesSchema.nullable(),
    delta_values: reconciliationDeltaValuesSchema,
    count: microAiuStringSchema,
    amount: decimal38_18Schema.nullable(),
    sample_event_ids: z
      .array(eventIdSchema)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, "Expected unique sample event IDs"),
    explanation: boundedUnicodeStringSchema({ minLength: 1, maxLength: 2000 }),
    status: reconciliationDiffStatusSchema,
    resolution: boundedUnicodeStringSchema({ minLength: 1, maxLength: 2000 }).nullable(),
    resolved_by: opaqueIdSchema.nullable(),
    resolved_at: utcTimestampSchema.nullable(),
    created_at: utcTimestampSchema,
  })
  .superRefine((diff, context) => {
    if (diff.diff_type === "WATERMARK_STALLED") {
      if (diff.dimensions !== null) {
        context.addIssue({
          code: "custom",
          message: "WATERMARK_STALLED does not use aggregate dimensions",
          path: ["dimensions"],
        });
      }
      if (
        diff.pg_values !== null ||
        diff.ch_values !== null ||
        Object.keys(diff.delta_values).length !== 0
      ) {
        context.addIssue({
          code: "custom",
          message: "WATERMARK_STALLED uses watermark evidence instead of metric maps",
          path: ["pg_values"],
        });
      }
    } else if (diff.dimensions === null) {
      context.addIssue({
        code: "custom",
        message: "Aggregate reconciliation differences require dimensions",
        path: ["dimensions"],
      });
    } else if (diff.pg_values === null && diff.ch_values === null) {
      context.addIssue({
        code: "custom",
        message: "At least one source metric map is required",
        path: ["pg_values"],
      });
    }

    if (diff.status === "resolved" || diff.status === "ignored") {
      if (diff.resolution === null) {
        context.addIssue({
          code: "custom",
          message: `${diff.status} requires a resolution note`,
          path: ["resolution"],
        });
      }
      if (diff.resolved_at === null) {
        context.addIssue({
          code: "custom",
          message: `${diff.status} requires resolved_at`,
          path: ["resolved_at"],
        });
      }
      if (diff.resolved_by === null) {
        context.addIssue({
          code: "custom",
          message: `${diff.status} requires resolved_by`,
          path: ["resolved_by"],
        });
      }
    }
  })
  .meta({
    id: "ReconciliationDiff",
    title: "Reconciliation Diff",
    description: "A classified, explainable difference between authoritative and projected data.",
  });

export type ReconciliationRun = z.infer<typeof reconciliationRunSchema>;
export type ReconciliationDiff = z.infer<typeof reconciliationDiffSchema>;

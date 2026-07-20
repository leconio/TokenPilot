import { z } from "zod";

import { compareUtcDateTimes } from "./common.js";
import { boundedUnicodeStringSchema, utcTimestampSchema } from "./primitives.js";

export const reportRangeSchema = z
  .strictObject({
    from: utcTimestampSchema,
    to: utcTimestampSchema,
    timezone: boundedUnicodeStringSchema({ minLength: 1, maxLength: 128 }),
  })
  .superRefine((range, context) => {
    if (compareUtcDateTimes(range.from, range.to) >= 0) {
      context.addIssue({
        code: "custom",
        message: "to must be later than from",
        path: ["to"],
      });
    }
  })
  .meta({ id: "ReportRange" });

const lagSecondsSchema = z.number().int().safe().nonnegative();

export const reportEnvelopeSchema = z
  .strictObject({
    watermark: utcTimestampSchema.nullable(),
    lag_seconds: lagSecondsSchema.nullable(),
    range: reportRangeSchema.nullable(),
    data: z.unknown(),
  })
  .meta({
    id: "ReportEnvelope",
    title: "Report Envelope",
    description: "Analytics result with a ClickHouse watermark and projection lag.",
  });

type EnvelopeWithData<TEnvelope, TData> = TEnvelope extends { readonly data: unknown }
  ? Omit<TEnvelope, "data"> & { readonly data: TData }
  : never;

export type ReportEnvelope<TData = unknown> = EnvelopeWithData<
  z.infer<typeof reportEnvelopeSchema>,
  TData
>;

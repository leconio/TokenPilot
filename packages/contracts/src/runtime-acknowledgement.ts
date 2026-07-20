import { z } from "zod";

import { contractIdSchema, semanticVersionSchema } from "./common.js";
import {
  boundedUnicodeStringSchema,
  sha256FingerprintSchema,
  utcTimestampSchema,
} from "./primitives.js";

export const runtimeConfigurationAcknowledgementSchema = z
  .strictObject({
    schema_version: z.literal("2.0"),
    application_id: z.string().uuid(),
    acknowledgement_id: contractIdSchema,
    acknowledged_at: utcTimestampSchema,
    connector: z.strictObject({
      instance_id: boundedUnicodeStringSchema({ minLength: 1, maxLength: 256 }),
      name: z.enum(["node", "python", "litellm"]),
      version: semanticVersionSchema,
    }),
    configuration_version: z.number().int().positive(),
    configuration_etag: sha256FingerprintSchema,
    state: z.enum(["received", "applied", "rejected"]),
    applied_at: utcTimestampSchema.nullable(),
    error: z
      .strictObject({
        code: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]*$/u)
          .max(120),
        message: boundedUnicodeStringSchema({ minLength: 1, maxLength: 500 }),
      })
      .nullable(),
  })
  .superRefine((acknowledgement, context) => {
    if (acknowledgement.state === "rejected" && acknowledgement.error === null) {
      context.addIssue({
        code: "custom",
        message: "A rejected acknowledgement requires error details",
        path: ["error"],
      });
    }
    if (acknowledgement.state === "applied" && acknowledgement.applied_at === null) {
      context.addIssue({
        code: "custom",
        message: "An applied acknowledgement requires applied_at",
        path: ["applied_at"],
      });
    }
    if (acknowledgement.state !== "applied" && acknowledgement.applied_at !== null) {
      context.addIssue({
        code: "custom",
        message: "Only an applied acknowledgement may include applied_at",
        path: ["applied_at"],
      });
    }
    if (acknowledgement.state !== "rejected" && acknowledgement.error !== null) {
      context.addIssue({
        code: "custom",
        message: "Only a rejected acknowledgement may include error details",
        path: ["error"],
      });
    }
    if (
      acknowledgement.applied_at !== null &&
      new Date(acknowledgement.applied_at).getTime() >
        new Date(acknowledgement.acknowledged_at).getTime()
    ) {
      context.addIssue({
        code: "custom",
        message: "applied_at cannot be later than acknowledged_at",
        path: ["applied_at"],
      });
    }
  })
  .meta({
    id: "RuntimeConfigurationAcknowledgement",
    title: "Runtime Configuration Acknowledgement",
    description:
      "A connector reports whether an application runtime configuration was received, applied, or rejected.",
  });

export type RuntimeConfigurationAcknowledgement = z.infer<
  typeof runtimeConfigurationAcknowledgementSchema
>;

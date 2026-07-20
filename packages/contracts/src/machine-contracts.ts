import { z } from "zod";

import {
  contractIdSchema,
  nullableMetadataStringSchema,
  semanticVersionSchema,
  utcDateTimeSchema,
} from "./common.js";

const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const connectorHeartbeatSchema = z
  .strictObject({
    schema_version: z.literal("2.0"),
    heartbeat_id: contractIdSchema,
    sent_at: utcDateTimeSchema,
    connector: z.strictObject({
      instance_id: z.string().min(1).max(256),
      name: z.string().min(1).max(120),
      type: z.enum(["litellm"]),
      version: semanticVersionSchema,
    }),
    capabilities: z.strictObject({
      usage_schema: z.literal("2.0"),
      application_users: z.literal(true),
      privacy_mode: z.literal("content_free"),
      durable_batch_upload: z.literal(true),
    }),
    status: z.enum(["healthy", "degraded"]),
    buffer_depth: nonNegativeSafeIntegerSchema,
    oldest_event_age_seconds: z.number().finite().nonnegative().nullable(),
    last_successful_upload_at: utcDateTimeSchema.nullable(),
  })
  .meta({
    id: "ConnectorHeartbeat",
    title: "Connector Heartbeat",
    description: "Health and durable-buffer state reported by a usage connector.",
  });

export const batchIngestionResponseSchema = z
  .strictObject({
    schema_version: z.literal("2.0"),
    batch_id: contractIdSchema,
    received_at: utcDateTimeSchema,
    accepted: nonNegativeSafeIntegerSchema,
    duplicates: nonNegativeSafeIntegerSchema,
    conflicts: nonNegativeSafeIntegerSchema,
    rejected: nonNegativeSafeIntegerSchema,
    results: z.array(
      z.strictObject({
        index: nonNegativeSafeIntegerSchema,
        event_id: contractIdSchema.nullable(),
        status: z.enum(["accepted", "duplicate", "conflict", "rejected"]),
        code: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]*$/)
          .max(120)
          .nullable()
          .optional(),
        message: z.string().min(1).max(500).nullable().optional(),
      }),
    ),
  })
  .superRefine((response, context) => {
    const expectedCounts = {
      accepted: response.accepted,
      duplicate: response.duplicates,
      conflict: response.conflicts,
      rejected: response.rejected,
    } as const;
    for (const [status, expected] of Object.entries(expectedCounts)) {
      const actual = response.results.filter((result) => result.status === status).length;
      if (actual !== expected) {
        context.addIssue({
          code: "custom",
          message: `${status} count does not match results`,
          path: ["results"],
        });
      }
    }
    const indexes = response.results.map((result) => result.index);
    if (new Set(indexes).size !== indexes.length) {
      context.addIssue({
        code: "custom",
        message: "Response result indexes must be unique",
        path: ["results"],
      });
    }
  })
  .meta({
    id: "BatchIngestionResponse",
    title: "Batch Ingestion Response",
    description: "Per-batch accepted, duplicate, conflict, and rejected usage-event results.",
  });

export const apiErrorSchema = z
  .strictObject({
    schema_version: z.literal("2.0"),
    error_id: contractIdSchema,
    occurred_at: utcDateTimeSchema,
    request_id: z.string().min(1).max(256),
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .max(120),
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
    details: z.array(
      z.strictObject({
        path: z.string().min(1).max(256),
        code: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]*$/)
          .max(120),
        message: z.string().min(1).max(500),
        rejected_value: nullableMetadataStringSchema.optional(),
      }),
    ),
  })
  .meta({
    id: "ApiError",
    title: "API Error",
    description: "A stable, privacy-safe machine and administration API error envelope.",
  });

export type ConnectorHeartbeat = z.infer<typeof connectorHeartbeatSchema>;
export type BatchIngestionResponse = z.infer<typeof batchIngestionResponseSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;

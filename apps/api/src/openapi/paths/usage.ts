import type { OpenApiSchema, OperationContract } from "../types.js";
import {
  array,
  body,
  DATE_TIME,
  id,
  object,
  pathString,
  POLICY_REASON,
  query,
  ref,
  success,
} from "../schema-helpers.js";
import {
  DLQ_REPLAY,
  GROUP_REPORT_QUERY,
  REPORT_QUERY,
  USAGE_REPORT_QUERY,
} from "../schemas/usage.js";

const report = (description: string): OperationContract => ({
  parameters: [pathString("applicationSlug"), ...REPORT_QUERY],
  success: success("200", ref("ReportEnvelope"), description),
});

export const USAGE_OPERATION_CONTRACTS: Readonly<Record<string, OperationContract>> = {
  "GET /applications/{applicationSlug}/requests/{requestId}": {
    parameters: [pathString("applicationSlug"), pathString("requestId")],
    success: success(
      "200",
      ref("RequestDetails"),
      "Application request details with user, model resolution, model cost, and AI Unit results.",
    ),
  },
  "GET /applications/{applicationSlug}/reports/overview": report(
    "Application analytics overview with watermark evidence.",
  ),
  "GET /applications/{applicationSlug}/reports/usage": {
    parameters: [pathString("applicationSlug"), ...USAGE_REPORT_QUERY],
    success: success(
      "200",
      ref("ReportEnvelope"),
      "Cursor-paged canonical Usage events ordered by event time and event ID.",
    ),
  },
  "GET /applications/{applicationSlug}/reports/usage/export": {
    parameters: [pathString("applicationSlug"), ...REPORT_QUERY],
    success: success(
      "200",
      { type: "string", format: "binary" },
      "Complete filtered Usage export with sensitive fields omitted.",
      "text/csv",
      {
        "Content-Disposition": {
          description: "Attachment filename.",
          schema: { type: "string" },
        },
      },
    ),
  },
  "GET /applications/{applicationSlug}/reports/activity": {
    parameters: [pathString("applicationSlug"), ...GROUP_REPORT_QUERY],
    success: success(
      "200",
      ref("ReportEnvelope"),
      "Cursor-paged call, Token, user, success-rate, or latency analysis.",
    ),
  },
  "GET /applications/{applicationSlug}/reports/provider-cost": {
    parameters: [pathString("applicationSlug"), ...GROUP_REPORT_QUERY],
    success: success("200", ref("ReportEnvelope"), "Cursor-paged Provider Cost groups."),
  },
  "GET /applications/{applicationSlug}/reports/aiu": {
    parameters: [pathString("applicationSlug"), ...GROUP_REPORT_QUERY],
    success: success("200", ref("ReportEnvelope"), "Cursor-paged AI Unit usage groups."),
  },
  "GET /applications/{applicationSlug}/reports/cache": report("Cache utilization breakdown."),
  "GET /applications/{applicationSlug}/reports/fallback": report("Fallback activity breakdown."),
  "GET /applications/{applicationSlug}/reports/dimensions": report("Governed dimension breakdown."),
  "GET /applications/{applicationSlug}/reports/pipeline-health": report(
    "Durable pipeline health and lag evidence.",
  ),
  "GET /dlq": {
    parameters: [
      query("stage", {
        type: "string",
        enum: [
          "received",
          "normalized",
          "model_resolved",
          "provider_cost_rated",
          "aiu_rated",
          "quota_settled",
          "official_committed",
          "outbox_created",
          "completed",
          "dead_letter",
        ],
      }),
      query("status", {
        type: "string",
        enum: ["open", "replay_queued", "resolved", "ignored"],
      }),
      query("page", { type: "integer", minimum: 1 }),
      query("page_size", { type: "integer", minimum: 1, maximum: 200 }),
    ],
    success: success(
      "200",
      object(["items", "page", "page_size", "total"], {
        items: array({ type: "object", additionalProperties: true }),
        page: { type: "integer", minimum: 1 },
        page_size: { type: "integer", minimum: 1, maximum: 200 },
        total: { type: "integer", minimum: 0 },
      }),
      "Paged durable dead-letter events.",
    ),
  },
  "POST /dlq/replay": {
    requestBody: body(DLQ_REPLAY),
    success: success(
      "201",
      object(["accepted", "outcome", "dead_letter_id", "event_id"], {
        accepted: { type: "boolean", enum: [true] },
        outcome: { type: "string", enum: ["queued", "idempotent"] },
        dead_letter_id: { type: "string", format: "uuid" },
        event_id: { type: "string", nullable: true },
      }),
      "Replay accepted.",
    ),
  },
  "POST /applications/{applicationSlug}/exports": {
    parameters: [pathString("applicationSlug")],
    requestBody: body(
      object(["from", "to", "reason"], {
        from: DATE_TIME,
        to: DATE_TIME,
        format: { type: "string", enum: ["csv"], default: "csv" } as OpenApiSchema,
        reason: POLICY_REASON,
      }),
    ),
    success: success("201", ref("BackgroundJob"), "Export job enqueued idempotently."),
  },
  "GET /applications/{applicationSlug}/jobs/{id}": {
    parameters: [pathString("applicationSlug"), id("id")],
    success: success("200", ref("BackgroundJob"), "Background Job status."),
  },
};

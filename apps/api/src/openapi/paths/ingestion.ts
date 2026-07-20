import type { OperationContract } from "../types.js";
import { body, object, ref, success } from "../schema-helpers.js";

export const INGESTION_OPERATION_CONTRACTS: Readonly<Record<string, OperationContract>> = {
  "POST /connectors/heartbeat": {
    requestBody: body(ref("ConnectorHeartbeatDto")),
    success: success(
      "202",
      object(["status", "heartbeat_id", "received_at", "snapshot_updated"], {
        status: { type: "string", enum: ["accepted", "duplicate"] },
        heartbeat_id: { type: "string", pattern: "^[0-9A-HJKMNP-TV-Z]{26}$" },
        received_at: { type: "string", format: "date-time" },
        snapshot_updated: { type: "boolean" },
      }),
      "Heartbeat accepted.",
    ),
  },
  "POST /usage-events/batch": {
    requestBody: body(ref("UsageBatchDto")),
    success: success(
      "202",
      ref("BatchIngestionResponseDto"),
      "Usage Events accepted for asynchronous processing.",
    ),
  },
};

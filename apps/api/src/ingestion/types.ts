import type { UsageEvent } from "@tokenpilot/contracts";

export type UsageIngestionStatus = "accepted" | "duplicate" | "conflict" | "rejected";

export interface UsageIngestionItemResult {
  readonly index: number;
  readonly event_id: string | null;
  readonly status: UsageIngestionStatus;
  readonly code?:
    "INVALID_EVENT" | "INVALID_PROPERTY" | "EVENT_TOO_LARGE" | "PAYLOAD_HASH_CONFLICT";
  readonly message?: string;
}

export interface UsageBatchResponse {
  readonly schema_version: "2.0";
  readonly batch_id: string;
  readonly received_at: string;
  readonly accepted: number;
  readonly duplicates: number;
  readonly conflicts: number;
  readonly rejected: number;
  readonly results: readonly UsageIngestionItemResult[];
}

export interface UsageIngestionOptions {
  readonly maxBatchSize: number;
  readonly maxBatchBytes: number;
  readonly maxEventBytes: number;
}

export interface ValidatedUsageEvent {
  readonly index: number;
  readonly event: UsageEvent;
  readonly payloadHash: string;
}

export type ReconciliationDiffType =
  | "CH_MISSING"
  | "PG_MISSING"
  | "DUPLICATE_PROJECTION"
  | "PAYLOAD_HASH_CONFLICT"
  | "USAGE_NORMALIZATION_MISMATCH"
  | "MODEL_IDENTITY_MISMATCH"
  | "PRICE_VERSION_MISMATCH"
  | "AIU_RATE_VERSION_MISMATCH"
  | "PROVISIONAL_OFFICIAL_DELTA_PENDING"
  | "LEDGER_PROJECTION_MISSING"
  | "LATE_EVENT"
  | "ADJUSTMENT_NOT_PROJECTED"
  | "WATERMARK_STALLED";

export type ReconciliationSeverity = "info" | "warning" | "error" | "critical";

export interface ReconciliationDimensions {
  readonly applicationId: string;
  readonly bucketStart: string;
  readonly bucketSize: "hour" | "day";
  readonly virtualModel: string | null;
  readonly modelId: string | null;
  readonly requestModel: string | null;
  readonly provider: string | null;
  readonly userId: string | null;
}

export interface ReconciliationMetrics {
  readonly eventCount: string;
  readonly inputTokens: string;
  readonly cachedInputTokens: string;
  readonly outputTokens: string;
  readonly providerCost: string;
  readonly aiuMicros: string;
  readonly unpricedCount: string;
  readonly unratedCount: string;
}

export interface ReconciliationSnapshotRow {
  readonly projectionId: string;
  readonly dimensions: ReconciliationDimensions;
  readonly metrics: ReconciliationMetrics;
  /** Physical rows beyond the distinct canonical event ids represented by this aggregate. */
  readonly duplicateProjectionCount?: string;
  readonly sampleEventIds: readonly string[];
  readonly modelIdentityFingerprint: string | null;
  readonly costVersionId: string | null;
  readonly aiuVersionId: string | null;
  readonly payloadHashConflict: boolean;
  readonly officialDeltaPending: boolean;
  readonly lateEventCount: string;
  readonly unprojectedAdjustmentCount: string;
}

export interface ReconciliationDiff {
  readonly type: ReconciliationDiffType;
  readonly severity: ReconciliationSeverity;
  readonly dimensions: ReconciliationDimensions | null;
  readonly count: string;
  readonly amount: string | null;
  readonly pgValues: ReconciliationMetrics | null;
  readonly chValues: ReconciliationMetrics | null;
  readonly deltaValues: Partial<ReconciliationMetrics>;
  readonly sampleEventIds: readonly string[];
  readonly explanation: string;
}

export interface ReconciliationTolerance {
  readonly providerCost: string;
  readonly aiuMicros: string;
  readonly watermarkStallSeconds: number;
}

export type ReplayType =
  | "reproject_to_clickhouse"
  | "rerun_provider_cost"
  | "rerun_aiu_observe"
  | "rebuild_quota_projection";

export interface ReplayPlan {
  readonly replayType: ReplayType;
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly dryRun: boolean;
  readonly reason: string | null;
  readonly requestedBy: string | null;
  readonly providerCostCorrection: "none" | "replacement_and_reversal";
  readonly aiuCorrection: "none" | "ledger_adjustment";
  readonly historicalAiuChargeAllowed: boolean;
}

export interface FreshClickHouseRebuildPlan {
  readonly rebuildId: string;
  readonly database: string;
  readonly steps: readonly (
    | "clear_isolated_database"
    | "create_current_schema"
    | "replay_postgresql_outbox"
    | "verify_current_projection"
  )[];
}

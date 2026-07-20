import type { NormalizedUsage, UsageEvent } from "@tokenpilot/contracts";
import type { Prisma } from "@tokenpilot/db";

export const PIPELINE_STAGES = [
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
] as const;

export type PipelineStageName = (typeof PIPELINE_STAGES)[number];

export interface PipelineReplayIntent {
  readonly runId: string;
  readonly authority: "reconciliation";
  readonly providerCost: "keep_existing" | "rerate";
  readonly aiu: "keep_unrated" | "backfill";
  readonly quota: "keep_existing";
}

export interface InboxLease {
  readonly id: string;
  readonly applicationId: string;
  readonly eventId: string;
  readonly payloadHash: string;
  readonly payload: unknown;
  readonly stage: PipelineStageName;
  readonly attemptCount: number;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
  readonly createdAt: Date;
  readonly replayIntent: PipelineReplayIntent | null;
}

export interface OutboxLease {
  readonly id: bigint;
  readonly applicationId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly idempotencyKey: string;
  readonly replayOfOutboxId: bigint | null;
  readonly attemptCount: number;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
  readonly createdAt: Date;
}

export interface PipelineResolutionArtifact {
  readonly status: "matched" | "unmapped" | "conflict" | "disabled";
  readonly modelId: string | null;
  readonly mappingFingerprint: string;
  readonly evidence?: unknown;
}

export interface PipelineSettlementContext {
  readonly applicationId: string;
  readonly event: UsageEvent;
  readonly normalized: NormalizedUsage;
  readonly resolution: PipelineResolutionArtifact;
  readonly providerCost: unknown;
  readonly aiu: unknown;
  readonly quota: unknown;
  readonly replayIntent: PipelineReplayIntent | null;
}

export interface PipelineOutboxMessage {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Prisma.InputJsonValue;
  readonly idempotencyKey: string;
}

export type PipelineMetricStage =
  | "normalization"
  | "model_resolution"
  | "provider_cost"
  | "aiu"
  | "quota"
  | "official_commit"
  | "outbox";

export type PipelineMetricStatus = "completed" | "retry" | "failed" | "dead_letter";

export interface PipelineStageMetric {
  readonly stage: PipelineMetricStage;
  readonly status: PipelineMetricStatus;
}

export type PipelineQuotaDecision = "allow" | "observe" | "warn" | "deny" | "downgrade";

export interface PipelineOfficialMetrics {
  readonly providerCostUnpriced?: boolean;
  readonly aiuUnrated?: boolean;
  readonly ratedAiuMicros?: string;
  readonly consumedAiuMicros?: string;
  readonly quotaDecision?: PipelineQuotaDecision;
}

export interface OfficialCommitResult {
  readonly additionalOutboxMessages?: readonly PipelineOutboxMessage[];
  readonly metrics?: PipelineOfficialMetrics;
}

export interface InboxOfficialCommitOutcome {
  readonly lease: InboxLease;
  readonly metrics?: PipelineOfficialMetrics;
}

export interface OfficialSettlementWriter {
  commit(
    transaction: Prisma.TransactionClient,
    context: PipelineSettlementContext,
  ): Promise<OfficialCommitResult>;
}

export interface PipelineStageHandlers {
  resolveModel(
    applicationId: string,
    normalized: NormalizedUsage,
  ): Promise<PipelineResolutionArtifact>;
  rateProviderCost(
    applicationId: string,
    normalized: NormalizedUsage,
    resolution: PipelineResolutionArtifact,
  ): Promise<unknown>;
  rateAiu(
    applicationId: string,
    normalized: NormalizedUsage,
    resolution: PipelineResolutionArtifact,
    providerCost: unknown,
  ): Promise<unknown>;
  settleQuota(applicationId: string, normalized: NormalizedUsage, aiu: unknown): Promise<unknown>;
}

export interface PipelineRuntimeFlags {
  readonly usagePipeline: boolean;
  readonly modelResolution: boolean;
  readonly providerCost: boolean;
  readonly aiu: boolean;
  readonly quota: boolean;
}

export interface InboxPipelineStore {
  leaseInbox(limit: number): Promise<readonly InboxLease[]>;
  checkpoint(lease: InboxLease, stage: PipelineStageName): Promise<InboxLease>;
  commitOfficial(
    lease: InboxLease,
    context: PipelineSettlementContext,
    writer: OfficialSettlementWriter,
  ): Promise<InboxOfficialCommitOutcome>;
  complete(lease: InboxLease): Promise<void>;
  retry(lease: InboxLease, error: PipelineFailure, retryAt: Date): Promise<void>;
  deadLetter(lease: InboxLease, error: PipelineFailure): Promise<void>;
}

export interface PipelineFailure {
  readonly code: string;
  readonly errorClass: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface PipelineProcessOutcome {
  readonly eventId: string;
  readonly status: "completed" | "retry_scheduled" | "failed" | "dead_lettered";
  readonly stage: PipelineStageName;
  readonly stageMetrics: readonly PipelineStageMetric[];
  readonly durationSeconds: number;
  readonly ratingMetrics?: PipelineOfficialMetrics & {
    readonly modelUnmapped?: boolean;
  };
  readonly errorCode?: string;
}

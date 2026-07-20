import { createHash } from "node:crypto";

import { usageEventSchema } from "@tokenpilot/contracts";

import { classifyPipelineError, retryDelayMs } from "./errors.js";
import { normalizeUsageEvent } from "./normalization.js";
import { PIPELINE_STAGES } from "./types.js";
import type {
  InboxLease,
  InboxPipelineStore,
  OfficialSettlementWriter,
  PipelineProcessOutcome,
  PipelineOfficialMetrics,
  PipelineResolutionArtifact,
  PipelineRuntimeFlags,
  PipelineStageMetric,
  PipelineStageHandlers,
  PipelineMetricStage,
  PipelineStageName,
} from "./types.js";

export interface PipelineProcessorOptions {
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly retryBaseDelayMs?: number;
}

function stageRank(stage: PipelineStageName): number {
  return PIPELINE_STAGES.indexOf(stage);
}

function disabledResolution(lease: InboxLease): PipelineResolutionArtifact {
  const fingerprint = createHash("sha256")
    .update(`model-resolution-disabled:${lease.eventId}:${lease.payloadHash}`)
    .digest("hex");
  return {
    status: "disabled",
    modelId: null,
    mappingFingerprint: `sha256:${fingerprint}`,
  };
}

function recordStageMetric(metrics: PipelineStageMetric[], metric: PipelineStageMetric): void {
  const existing = metrics.findIndex((candidate) => candidate.stage === metric.stage);
  if (existing === -1) metrics.push(metric);
  else metrics[existing] = metric;
}

function withDuration(
  startedAt: number,
  outcome: Omit<PipelineProcessOutcome, "durationSeconds">,
): PipelineProcessOutcome {
  return {
    ...outcome,
    durationSeconds: Math.max(0, (performance.now() - startedAt) / 1_000),
  };
}

export class UsagePipelineProcessor {
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;

  constructor(
    private readonly store: InboxPipelineStore,
    private readonly handlers: PipelineStageHandlers,
    private readonly officialWriter: OfficialSettlementWriter,
    private readonly flags: PipelineRuntimeFlags,
    options: PipelineProcessorOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 1_000) {
      throw new RangeError("Pipeline batch size must be between 1 and 1000");
    }
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new RangeError("Pipeline max attempts must be a positive integer");
    }
  }

  async runBatch(): Promise<readonly PipelineProcessOutcome[]> {
    if (!this.flags.usagePipeline) return [];
    const leases = await this.store.leaseInbox(this.batchSize);
    const outcomes = new Array<PipelineProcessOutcome>(leases.length);
    const lanes = new Map<string, Array<{ readonly index: number; readonly lease: InboxLease }>>();
    for (const [index, lease] of leases.entries()) {
      const parsed = usageEventSchema.safeParse(lease.payload);
      // Quota settlement is an ordered per-user ledger. Keep attempts for the
      // same application user in one lane so a batch cannot create a
      // serialization-failure retry storm. Independent users still run in
      // parallel, and invalid payloads retain independent dead-letter paths.
      const lane = parsed.success
        ? `${lease.applicationId}\u0000${parsed.data.user.user_id}`
        : `${lease.applicationId}\u0000invalid\u0000${lease.id}`;
      const entries = lanes.get(lane) ?? [];
      entries.push({ index, lease });
      lanes.set(lane, entries);
    }
    await Promise.all(
      [...lanes.values()].map(async (entries) => {
        for (const entry of entries) outcomes[entry.index] = await this.process(entry.lease);
      }),
    );
    return outcomes;
  }

  async process(initialLease: InboxLease): Promise<PipelineProcessOutcome> {
    const startedAt = performance.now();
    let lease = initialLease;
    let activeStage: PipelineMetricStage = "normalization";
    const stageMetrics: PipelineStageMetric[] = [];
    let ratingMetrics: PipelineOfficialMetrics & { readonly modelUnmapped?: boolean } = {};
    try {
      const event = usageEventSchema.parse(lease.payload);
      const normalized = normalizeUsageEvent(event);
      const normalizedCheckpoint = await this.advanceIfNeeded(lease, "normalized");
      lease = normalizedCheckpoint.lease;
      if (normalizedCheckpoint.advanced) {
        recordStageMetric(stageMetrics, { stage: "normalization", status: "completed" });
      }

      activeStage = "model_resolution";
      const resolution =
        this.flags.modelResolution || lease.replayIntent !== null
          ? await this.handlers.resolveModel(lease.applicationId, normalized)
          : disabledResolution(lease);
      const resolutionCheckpoint = await this.advanceIfNeeded(lease, "model_resolved");
      lease = resolutionCheckpoint.lease;
      if (resolutionCheckpoint.advanced) {
        recordStageMetric(stageMetrics, { stage: "model_resolution", status: "completed" });
        if (resolution.status === "unmapped" || resolution.status === "conflict") {
          ratingMetrics = { ...ratingMetrics, modelUnmapped: true };
        }
      }

      activeStage = "provider_cost";
      const providerCostEnabled =
        lease.replayIntent === null
          ? this.flags.providerCost
          : lease.replayIntent.providerCost === "rerate";
      const providerCost = providerCostEnabled
        ? await this.handlers.rateProviderCost(lease.applicationId, normalized, resolution)
        : { status: "disabled" };
      const providerCheckpoint = await this.advanceIfNeeded(lease, "provider_cost_rated");
      lease = providerCheckpoint.lease;
      if (providerCheckpoint.advanced) {
        recordStageMetric(stageMetrics, { stage: "provider_cost", status: "completed" });
      }

      activeStage = "aiu";
      const aiuEnabled =
        lease.replayIntent === null ? this.flags.aiu : lease.replayIntent.aiu === "backfill";
      const aiu = aiuEnabled
        ? await this.handlers.rateAiu(lease.applicationId, normalized, resolution, providerCost)
        : { status: "disabled" };
      const aiuCheckpoint = await this.advanceIfNeeded(lease, "aiu_rated");
      lease = aiuCheckpoint.lease;
      if (aiuCheckpoint.advanced) {
        recordStageMetric(stageMetrics, { stage: "aiu", status: "completed" });
      }

      activeStage = "quota";
      const quota =
        aiuEnabled && this.flags.quota && lease.replayIntent?.quota !== "keep_existing"
          ? await this.handlers.settleQuota(lease.applicationId, normalized, aiu)
          : { status: "not_applicable" };
      const quotaCheckpoint = await this.advanceIfNeeded(lease, "quota_settled");
      lease = quotaCheckpoint.lease;
      if (quotaCheckpoint.advanced) {
        recordStageMetric(stageMetrics, { stage: "quota", status: "completed" });
      }

      activeStage = "official_commit";
      if (stageRank(lease.stage) < stageRank("outbox_created")) {
        const stageBeforeCommit = lease.stage;
        const committed = await this.store.commitOfficial(
          lease,
          {
            applicationId: lease.applicationId,
            event,
            normalized,
            resolution,
            providerCost,
            aiu,
            quota,
            replayIntent: lease.replayIntent,
          },
          this.officialWriter,
        );
        lease = committed.lease;
        if (stageRank(stageBeforeCommit) < stageRank("official_committed")) {
          recordStageMetric(stageMetrics, { stage: "official_commit", status: "completed" });
        }
        recordStageMetric(stageMetrics, { stage: "outbox", status: "completed" });
        ratingMetrics = { ...ratingMetrics, ...committed.metrics };
      }
      activeStage = "outbox";
      await this.store.complete(lease);
      return withDuration(startedAt, {
        eventId: lease.eventId,
        status: "completed",
        stage: "completed",
        stageMetrics,
        ...(Object.keys(ratingMetrics).length === 0 ? {} : { ratingMetrics }),
      });
    } catch (error) {
      const failure = classifyPipelineError(error, lease.stage);
      if (failure.retryable && lease.attemptCount < this.maxAttempts) {
        const retryAt = new Date(
          Date.now() + retryDelayMs(lease.attemptCount, this.retryBaseDelayMs),
        );
        try {
          await this.store.retry(lease, failure, retryAt);
        } catch {
          recordStageMetric(stageMetrics, { stage: activeStage, status: "failed" });
          return withDuration(startedAt, {
            eventId: lease.eventId,
            status: "failed",
            stage: lease.stage,
            stageMetrics,
            ...(Object.keys(ratingMetrics).length === 0 ? {} : { ratingMetrics }),
            errorCode: "PIPELINE_FAILURE_PERSISTENCE_FAILED",
          });
        }
        recordStageMetric(stageMetrics, { stage: activeStage, status: "retry" });
        return withDuration(startedAt, {
          eventId: lease.eventId,
          status: "retry_scheduled",
          stage: lease.stage,
          stageMetrics,
          ...(Object.keys(ratingMetrics).length === 0 ? {} : { ratingMetrics }),
          errorCode: failure.code,
        });
      }
      const exhausted = failure.retryable
        ? {
            ...failure,
            code: "PIPELINE_RETRY_EXHAUSTED",
            retryable: false,
            details: { ...failure.details, last_error_code: failure.code },
          }
        : failure;
      try {
        await this.store.deadLetter(lease, exhausted);
      } catch {
        recordStageMetric(stageMetrics, { stage: activeStage, status: "failed" });
        return withDuration(startedAt, {
          eventId: lease.eventId,
          status: "failed",
          stage: lease.stage,
          stageMetrics,
          ...(Object.keys(ratingMetrics).length === 0 ? {} : { ratingMetrics }),
          errorCode: "PIPELINE_FAILURE_PERSISTENCE_FAILED",
        });
      }
      recordStageMetric(stageMetrics, { stage: activeStage, status: "dead_letter" });
      return withDuration(startedAt, {
        eventId: lease.eventId,
        status: "dead_lettered",
        stage: "dead_letter",
        stageMetrics,
        ...(Object.keys(ratingMetrics).length === 0 ? {} : { ratingMetrics }),
        errorCode: exhausted.code,
      });
    }
  }

  private async advanceIfNeeded(
    lease: InboxLease,
    target: PipelineStageName,
  ): Promise<{ readonly lease: InboxLease; readonly advanced: boolean }> {
    if (stageRank(lease.stage) >= stageRank(target)) return { lease, advanced: false };
    return { lease: await this.store.checkpoint(lease, target), advanced: true };
  }
}

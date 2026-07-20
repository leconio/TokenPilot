import { describe, expect, it, vi } from "vitest";

import type { UsageEvent } from "@tokenpilot/contracts";

import { RetryablePipelineError } from "../../src/pipeline/errors.js";
import { UsagePipelineProcessor } from "../../src/pipeline/processor.js";
import type {
  InboxLease,
  InboxPipelineStore,
  OfficialSettlementWriter,
  PipelineRuntimeFlags,
  PipelineStageHandlers,
  PipelineStageName,
} from "../../src/pipeline/types.js";

function usageEvent(): UsageEvent {
  return {
    schema_version: "2.0",
    event_id: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
    event_time: "2026-07-16T08:00:00.000Z",
    user: { user_id: "pipeline-user", display_user: "Pipeline user" },
    source: { type: "gateway", name: "gateway", version: "1", instance_id: "gw-1" },
    request: {
      request_id: "request-1",
      attempt_id: "attempt-1",
      operation_id: "operation-1",
      parent_request_id: null,
      session_id: null,
      conversation_id: null,
      trace_id: null,
    },
    model: {
      virtual_model: "chat",
      model_tag: "openai/gpt-test",
      provider: "openai",
    },
    route: null,
    analytics_dimensions: { team: "platform" },
    result: { status: "success", http_status: 200, latency_ms: 10, error_class: null },
    source_cost: null,
    privacy: { contains_prompt: false, contains_response: false },
    usage: { uncached_input_tokens: "12", output_tokens: "3" },
  };
}

function lease(overrides: Partial<InboxLease> = {}): InboxLease {
  return {
    id: "6df8789e-764d-40e7-a231-f38f6469acfd",
    applicationId: "00000000-0000-4000-8000-000000000001",
    eventId: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
    payloadHash: "a".repeat(64),
    payload: usageEvent(),
    stage: "received",
    attemptCount: 1,
    leaseOwner: "worker:lease-1",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date("2026-07-16T08:00:00Z"),
    replayIntent: null,
    ...overrides,
  };
}

function laneLease(index: number, userId: string): InboxLease {
  const event = usageEvent();
  const eventId = `${event.event_id.slice(0, -1)}${index}`;
  return lease({
    id: `6df8789e-764d-40e7-a231-f38f6469acf${index}`,
    eventId,
    leaseOwner: `worker:lease-${index}`,
    payload: {
      ...event,
      event_id: eventId,
      user: { ...event.user, user_id: userId },
      request: {
        ...event.request,
        request_id: `request-${index}`,
        attempt_id: `attempt-${index}`,
        operation_id: `operation-${index}`,
      },
    },
  });
}

function fixture(initial = lease()) {
  const order: string[] = [];
  const checkpoints: PipelineStageName[] = [];
  const store: InboxPipelineStore = {
    leaseInbox: vi.fn(async () => [initial]),
    checkpoint: vi.fn(async (current, stage) => {
      order.push(stage);
      checkpoints.push(stage);
      return {
        ...current,
        stage,
        leaseExpiresAt: new Date(current.leaseExpiresAt.getTime() + 1_000),
      };
    }),
    commitOfficial: vi.fn(async (current, context, writer) => {
      order.push("official_committed");
      const committed = await writer.commit({} as never, context);
      order.push("outbox_created");
      return {
        lease: { ...current, stage: "outbox_created" },
        ...(committed.metrics === undefined ? {} : { metrics: committed.metrics }),
      };
    }),
    complete: vi.fn(async () => {
      order.push("completed");
    }),
    retry: vi.fn(async () => undefined),
    deadLetter: vi.fn(async () => undefined),
  };
  const handlers: PipelineStageHandlers = {
    resolveModel: vi.fn(async () => {
      order.push("resolve_model");
      return {
        status: "matched" as const,
        modelId: "base-model-1",
        mappingFingerprint: `sha256:${"b".repeat(64)}`,
      };
    }),
    rateProviderCost: vi.fn(async () => {
      order.push("provider_cost");
      return { status: "official", total: "0.001" };
    }),
    rateAiu: vi.fn(async () => {
      order.push("aiu");
      return { status: "official", total: "1000" };
    }),
    settleQuota: vi.fn(async () => {
      order.push("quota");
      return { status: "settled" };
    }),
  };
  const officialWriter: OfficialSettlementWriter = {
    commit: vi.fn(async () => {
      order.push("official_writer");
      return {};
    }),
  };
  const flags: PipelineRuntimeFlags = {
    usagePipeline: true,
    modelResolution: true,
    providerCost: true,
    aiu: true,
    quota: true,
  };
  return { store, handlers, officialWriter, flags, order, checkpoints };
}

describe("UsagePipelineProcessor", () => {
  it("runs the monotonic normalization/model/cost/AIU/quota/official/outbox sequence", async () => {
    const f = fixture();
    const processor = new UsagePipelineProcessor(f.store, f.handlers, f.officialWriter, f.flags);
    const outcomes = await processor.runBatch();

    expect(outcomes).toEqual([
      expect.objectContaining({
        eventId: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
        status: "completed",
        stage: "completed",
        stageMetrics: [
          { stage: "normalization", status: "completed" },
          { stage: "model_resolution", status: "completed" },
          { stage: "provider_cost", status: "completed" },
          { stage: "aiu", status: "completed" },
          { stage: "quota", status: "completed" },
          { stage: "official_commit", status: "completed" },
          { stage: "outbox", status: "completed" },
        ],
      }),
    ]);
    expect(f.order).toEqual([
      "normalized",
      "resolve_model",
      "model_resolved",
      "provider_cost",
      "provider_cost_rated",
      "aiu",
      "aiu_rated",
      "quota",
      "quota_settled",
      "official_committed",
      "official_writer",
      "outbox_created",
      "completed",
    ]);
  });

  it("serializes one application user while processing independent users in parallel", async () => {
    const f = fixture();
    const leases = [
      laneLease(1, "shared-user"),
      laneLease(2, "shared-user"),
      laneLease(3, "other-user"),
    ];
    vi.mocked(f.store.leaseInbox).mockResolvedValueOnce(leases);
    let active = 0;
    let maximumActive = 0;
    const activeUsers = new Set<string>();
    let sameUserOverlap = false;
    vi.mocked(f.store.commitOfficial).mockImplementation(async (current, context) => {
      const userId = context.event.user.user_id;
      if (activeUsers.has(userId)) sameUserOverlap = true;
      activeUsers.add(userId);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      activeUsers.delete(userId);
      return { lease: { ...current, stage: "outbox_created" } };
    });
    const processor = new UsagePipelineProcessor(f.store, f.handlers, f.officialWriter, f.flags);

    const outcomes = await processor.runBatch();

    expect(sameUserOverlap).toBe(false);
    expect(maximumActive).toBe(2);
    expect(outcomes.map((outcome) => outcome.eventId)).toEqual(leases.map((item) => item.eventId));
    expect(outcomes.every((outcome) => outcome.status === "completed")).toBe(true);
  });

  it("gates every optional side effect while still durably projecting raw usage", async () => {
    const f = fixture();
    const processor = new UsagePipelineProcessor(f.store, f.handlers, f.officialWriter, {
      usagePipeline: true,
      modelResolution: false,
      providerCost: false,
      aiu: false,
      quota: false,
    });
    await processor.runBatch();

    expect(f.handlers.resolveModel).not.toHaveBeenCalled();
    expect(f.handlers.rateProviderCost).not.toHaveBeenCalled();
    expect(f.handlers.rateAiu).not.toHaveBeenCalled();
    expect(f.handlers.settleQuota).not.toHaveBeenCalled();
    expect(f.officialWriter.commit).toHaveBeenCalledOnce();
  });

  it.each([
    ["rerun_provider_cost", "rerate", "keep_unrated", 1, 0],
    ["rerun_aiu_observe", "keep_existing", "backfill", 0, 1],
  ] as const)(
    "keeps quota unchanged during reconciliation %s",
    async (_replayType, providerCost, aiu, providerCalls, aiuCalls) => {
      const f = fixture(
        lease({
          replayIntent: {
            runId: "d4f14052-7237-4e0c-8619-392140c124a4",
            authority: "reconciliation",
            providerCost,
            aiu,
            quota: "keep_existing",
          },
        }),
      );
      const processor = new UsagePipelineProcessor(f.store, f.handlers, f.officialWriter, f.flags);

      await processor.runBatch();

      expect(f.handlers.resolveModel).toHaveBeenCalledOnce();
      expect(f.handlers.rateProviderCost).toHaveBeenCalledTimes(providerCalls);
      expect(f.handlers.rateAiu).toHaveBeenCalledTimes(aiuCalls);
      expect(f.handlers.settleQuota).not.toHaveBeenCalled();
      expect(f.officialWriter.commit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          replayIntent: expect.objectContaining({
            authority: "reconciliation",
            quota: "keep_existing",
          }),
        }),
      );
    },
  );

  it("does not lease inbox work while Usage pipeline is disabled", async () => {
    const f = fixture();
    const processor = new UsagePipelineProcessor(f.store, f.handlers, f.officialWriter, {
      ...f.flags,
      usagePipeline: false,
    });
    await expect(processor.runBatch()).resolves.toEqual([]);
    expect(f.store.leaseInbox).not.toHaveBeenCalled();
  });

  it("persists retryable failures with backoff and never performs the official commit", async () => {
    const f = fixture();
    vi.mocked(f.handlers.rateProviderCost).mockRejectedValueOnce(
      new RetryablePipelineError("PRICE_DEPENDENCY_UNAVAILABLE", "price store unavailable"),
    );
    const processor = new UsagePipelineProcessor(f.store, f.handlers, f.officialWriter, f.flags, {
      retryBaseDelayMs: 1,
    });
    const outcome = await processor.runBatch();

    expect(outcome[0]).toMatchObject({
      status: "retry_scheduled",
      stage: "model_resolved",
      errorCode: "PRICE_DEPENDENCY_UNAVAILABLE",
      stageMetrics: [
        { stage: "normalization", status: "completed" },
        { stage: "model_resolution", status: "completed" },
        { stage: "provider_cost", status: "retry" },
      ],
    });
    expect(f.store.retry).toHaveBeenCalledOnce();
    expect(f.store.commitOfficial).not.toHaveBeenCalled();
  });

  it("dead-letters permanent payload errors and exhausted transient failures", async () => {
    const invalid = fixture(lease({ payload: { schema_version: "2.0" } }));
    const invalidProcessor = new UsagePipelineProcessor(
      invalid.store,
      invalid.handlers,
      invalid.officialWriter,
      invalid.flags,
    );
    await expect(invalidProcessor.runBatch()).resolves.toEqual([
      expect.objectContaining({
        status: "dead_lettered",
        errorCode: "INVALID_USAGE_PAYLOAD",
        stageMetrics: [{ stage: "normalization", status: "dead_letter" }],
      }),
    ]);
    expect(invalid.store.deadLetter).toHaveBeenCalledOnce();

    const exhausted = fixture(lease({ attemptCount: 8 }));
    vi.mocked(exhausted.handlers.rateAiu).mockRejectedValueOnce(
      new RetryablePipelineError("AIU_STORE_UNAVAILABLE", "AIU store unavailable"),
    );
    const exhaustedProcessor = new UsagePipelineProcessor(
      exhausted.store,
      exhausted.handlers,
      exhausted.officialWriter,
      exhausted.flags,
      { maxAttempts: 8 },
    );
    const result = await exhaustedProcessor.runBatch();
    expect(result[0]).toMatchObject({
      status: "dead_lettered",
      errorCode: "PIPELINE_RETRY_EXHAUSTED",
    });
    expect(exhausted.store.retry).not.toHaveBeenCalled();
    expect(exhausted.store.deadLetter).toHaveBeenCalledOnce();
  });

  it("re-enters pure stages after a crash but never regresses persisted stage checkpoints", async () => {
    const f = fixture(lease({ stage: "provider_cost_rated" }));
    const processor = new UsagePipelineProcessor(f.store, f.handlers, f.officialWriter, f.flags);
    const [outcome] = await processor.runBatch();

    expect(f.handlers.resolveModel).toHaveBeenCalledOnce();
    expect(f.handlers.rateProviderCost).toHaveBeenCalledOnce();
    expect(f.checkpoints).toEqual(["aiu_rated", "quota_settled"]);
    expect(outcome?.stageMetrics).toEqual([
      { stage: "aiu", status: "completed" },
      { stage: "quota", status: "completed" },
      { stage: "official_commit", status: "completed" },
      { stage: "outbox", status: "completed" },
    ]);
  });

  it("propagates only transaction-confirmed rating and quota observations", async () => {
    const f = fixture();
    vi.mocked(f.officialWriter.commit).mockResolvedValueOnce({
      metrics: {
        providerCostUnpriced: true,
        aiuUnrated: true,
        ratedAiuMicros: "125",
        consumedAiuMicros: "100",
        quotaDecision: "allow",
      },
    });
    const processor = new UsagePipelineProcessor(f.store, f.handlers, f.officialWriter, f.flags);

    const [outcome] = await processor.runBatch();

    expect(outcome?.ratingMetrics).toEqual({
      providerCostUnpriced: true,
      aiuUnrated: true,
      ratedAiuMicros: "125",
      consumedAiuMicros: "100",
      quotaDecision: "allow",
    });
  });

  it("reports an outbox retry once when finalization fails after the atomic commit", async () => {
    const f = fixture();
    vi.mocked(f.store.complete).mockRejectedValueOnce(
      new RetryablePipelineError("INBOX_COMPLETE_FAILED", "completion unavailable"),
    );
    const processor = new UsagePipelineProcessor(f.store, f.handlers, f.officialWriter, f.flags, {
      retryBaseDelayMs: 1,
    });

    const [outcome] = await processor.runBatch();

    expect(outcome?.stageMetrics).toEqual([
      { stage: "normalization", status: "completed" },
      { stage: "model_resolution", status: "completed" },
      { stage: "provider_cost", status: "completed" },
      { stage: "aiu", status: "completed" },
      { stage: "quota", status: "completed" },
      { stage: "official_commit", status: "completed" },
      { stage: "outbox", status: "retry" },
    ]);
  });

  it("reports one failed stage when retry state cannot be persisted", async () => {
    const f = fixture();
    vi.mocked(f.handlers.rateProviderCost).mockRejectedValueOnce(
      new RetryablePipelineError("PRICE_DEPENDENCY_UNAVAILABLE", "price store unavailable"),
    );
    vi.mocked(f.store.retry).mockRejectedValueOnce(new Error("database unavailable"));
    const processor = new UsagePipelineProcessor(f.store, f.handlers, f.officialWriter, f.flags);

    const [outcome] = await processor.runBatch();

    expect(outcome).toMatchObject({
      status: "failed",
      errorCode: "PIPELINE_FAILURE_PERSISTENCE_FAILED",
      stageMetrics: [
        { stage: "normalization", status: "completed" },
        { stage: "model_resolution", status: "completed" },
        { stage: "provider_cost", status: "failed" },
      ],
    });
  });
});

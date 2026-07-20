import { describe, expect, it, vi } from "vitest";

import type { UsageEvent } from "@tokenpilot/contracts";
import { AiuReservationStatus, type Prisma } from "@tokenpilot/db";

import { ApplicationUsageOfficialWriter } from "../../src/application-usage/official-writer.js";
import { normalizeUsageEvent } from "../../src/pipeline/normalization.js";
import type { PipelineSettlementContext } from "../../src/pipeline/types.js";

const applicationId = "00000000-0000-4000-8000-000000000901";
const applicationUserId = "00000000-0000-4000-8000-000000000902";
const modelId = "00000000-0000-4000-8000-000000000903";
const reservationId = "00000000-0000-4000-8000-000000000904";
const quotaId = "00000000-0000-4000-8000-000000000905";

function event(): UsageEvent {
  return {
    schema_version: "2.0",
    event_id: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
    event_time: "2026-07-18T01:00:00.000Z",
    user: { user_id: "customer-42", display_user: "Ada" },
    source: { type: "gateway", name: "litellm", version: "1", instance_id: "gateway-1" },
    request: {
      request_id: "request-1",
      attempt_id: "attempt-1",
      attempt_index: 0,
      is_final_attempt: true,
      operation_id: "operation-1",
      parent_request_id: null,
      session_id: null,
      conversation_id: null,
      trace_id: null,
      reservation_id: reservationId,
    },
    model: {
      virtual_model: "assistant.fast",
      model_id: modelId,
      request_model: "openai/gpt-5-mini",
      provider: "openai",
    },
    route: null,
    analytics_dimensions: {},
    result: { status: "success", http_status: 200, latency_ms: 25, error_class: null },
    source_cost: null,
    privacy: { contains_prompt: false, contains_response: false },
    usage: { uncached_input_tokens: "10", output_tokens: "2" },
  };
}

function context(overrides: Partial<PipelineSettlementContext> = {}): PipelineSettlementContext {
  const usageEvent = event();
  return {
    applicationId,
    event: usageEvent,
    normalized: normalizeUsageEvent(usageEvent),
    resolution: {
      status: "matched",
      modelId: modelId,
      mappingFingerprint: `sha256:${"a".repeat(64)}`,
    },
    providerCost: {
      kind: "application_cost",
      status: "official",
      versionId: "00000000-0000-4000-8000-000000000906",
      currency: "USD",
      total: "0.002000000000000000",
      lines: [],
    },
    aiu: {
      kind: "application_aiu",
      status: "official",
      versionId: "00000000-0000-4000-8000-000000000907",
      totalMicros: 5n,
      lines: [],
    },
    quota: { kind: "application_quota", reservationId },
    replayIntent: null,
    ...overrides,
  };
}

function baseTransaction(overrides: Record<string, unknown> = {}) {
  const ratingCreate = vi.fn().mockResolvedValue({ id: "rating-1", modelId });
  const ledgerCreate = vi.fn().mockResolvedValue({ id: "ledger-1" });
  return {
    application: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ timezone: "UTC" }),
    },
    usageEventRegistry: {
      findFirstOrThrow: vi.fn().mockResolvedValue({ applicationUserId, reservationId }),
    },
    applicationUsageRating: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: ratingCreate,
    },
    userAiuReservation: {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    aiuQuotaPolicy: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    applicationUserGroup: {},
    userAiuQuota: {
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    userAiuLedgerEntry: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: ledgerCreate,
    },
    ...overrides,
    _ratingCreate: ratingCreate,
    _ledgerCreate: ledgerCreate,
  };
}

describe("application usage official writer", () => {
  it("settles a hard-limit reservation in the same application transaction", async () => {
    const transaction = baseTransaction();
    transaction.userAiuReservation.findFirst.mockResolvedValue({
      id: reservationId,
      applicationId,
      userId: applicationUserId,
      quotaId,
      status: AiuReservationStatus.RESERVED,
      reservedAiuMicros: 8n,
      settledAiuMicros: 0n,
      lockVersion: 4,
      quota: {
        id: quotaId,
        lockVersion: 7,
        limitAiuMicros: 100n,
        consumedAiuMicros: 20n,
        reservedAiuMicros: 8n,
      },
    });

    const result = await new ApplicationUsageOfficialWriter().commit(
      transaction as unknown as Prisma.TransactionClient,
      context(),
    );

    expect(transaction.userAiuReservation.findFirst).toHaveBeenCalledWith({
      where: { applicationId, id: reservationId, userId: applicationUserId },
      include: { quota: true },
    });
    expect(transaction.userAiuReservation.updateMany).toHaveBeenCalledWith({
      where: {
        applicationId,
        id: reservationId,
        status: AiuReservationStatus.RESERVED,
        lockVersion: 4,
      },
      data: expect.objectContaining({
        status: AiuReservationStatus.SETTLED,
        settledAiuMicros: 5n,
        lockVersion: { increment: 1 },
      }),
    });
    expect(transaction.userAiuQuota.updateMany).toHaveBeenCalledWith({
      where: { applicationId, id: quotaId, lockVersion: 7 },
      data: {
        reservedAiuMicros: { decrement: 8n },
        consumedAiuMicros: { increment: 5n },
        lockVersion: { increment: 1 },
      },
    });
    expect(transaction._ledgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationId,
        userId: applicationUserId,
        sourceEventId: event().event_id,
        sourceReservationId: reservationId,
        consumedDeltaMicros: 5n,
        reservedDeltaMicros: -8n,
        consumedAfterMicros: 25n,
        reservedAfterMicros: 0n,
      }),
    });
    expect(result.metrics).toMatchObject({
      ratedAiuMicros: "5",
      consumedAiuMicros: "5",
      quotaDecision: "allow",
    });
    expect(result.additionalOutboxMessages).toHaveLength(2);
    expect(
      result.additionalOutboxMessages?.every((message) => {
        const payload = message.payload as Record<string, Prisma.JsonValue>;
        return String(payload.application_id) === applicationId;
      }),
    ).toBe(true);
  });

  it("reconciles a client-side estimate to the final rated AIU", async () => {
    const transaction = baseTransaction();
    transaction.userAiuReservation.findFirst.mockResolvedValue({
      id: reservationId,
      applicationId,
      userId: applicationUserId,
      quotaId,
      status: AiuReservationStatus.SETTLED,
      reservedAiuMicros: 8n,
      settledAiuMicros: 8n,
      lockVersion: 5,
      quota: {
        id: quotaId,
        lockVersion: 8,
        limitAiuMicros: 100n,
        consumedAiuMicros: 28n,
        reservedAiuMicros: 0n,
      },
    });

    const result = await new ApplicationUsageOfficialWriter().commit(
      transaction as unknown as Prisma.TransactionClient,
      context(),
    );

    expect(transaction.userAiuReservation.updateMany).toHaveBeenCalledWith({
      where: {
        applicationId,
        id: reservationId,
        status: AiuReservationStatus.SETTLED,
        lockVersion: 5,
      },
      data: { settledAiuMicros: 5n, lockVersion: { increment: 1 } },
    });
    expect(transaction.userAiuQuota.updateMany).toHaveBeenCalledWith({
      where: { applicationId, id: quotaId, lockVersion: 8 },
      data: { consumedAiuMicros: { increment: -3n }, lockVersion: { increment: 1 } },
    });
    expect(transaction._ledgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        idempotencyKey: `user-usage:${event().event_id}:settle-reconciliation`,
        consumedDeltaMicros: -3n,
        reservedDeltaMicros: 0n,
        consumedAfterMicros: 25n,
      }),
    });
    expect(result.metrics?.consumedAiuMicros).toBe("5");
  });

  it("consumes rated AIU once in observe mode when no reservation exists", async () => {
    const transaction = baseTransaction();
    transaction.usageEventRegistry.findFirstOrThrow.mockResolvedValue({
      applicationUserId,
      reservationId: null,
    });
    transaction.userAiuQuota.findUnique.mockResolvedValue({
      id: quotaId,
      policyId: null,
      enabled: true,
      hardLimit: false,
      lockVersion: 2,
      consumedAiuMicros: 10n,
      reservedAiuMicros: 0n,
      limitAiuMicros: 100n,
    });

    const result = await new ApplicationUsageOfficialWriter().commit(
      transaction as unknown as Prisma.TransactionClient,
      context({ quota: { kind: "application_quota", reservationId: null } }),
    );

    expect(transaction.userAiuQuota.updateMany).toHaveBeenCalledWith({
      where: { applicationId, id: quotaId, lockVersion: 2 },
      data: { consumedAiuMicros: { increment: 5n }, lockVersion: { increment: 1 } },
    });
    expect(transaction._ledgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        idempotencyKey: `user-usage:${event().event_id}:consume`,
        consumedDeltaMicros: 5n,
        consumedAfterMicros: 15n,
      }),
    });
    expect(result.metrics?.consumedAiuMicros).toBe("5");
    expect(result.metrics?.quotaDecision).toBe("observe");
  });

  it("records a warning without blocking when a soft limit is exceeded", async () => {
    const transaction = baseTransaction();
    transaction.usageEventRegistry.findFirstOrThrow.mockResolvedValue({
      applicationUserId,
      reservationId: null,
    });
    transaction.userAiuQuota.findUnique.mockResolvedValue({
      id: quotaId,
      policyId: null,
      enabled: true,
      hardLimit: false,
      lockVersion: 3,
      consumedAiuMicros: 98n,
      reservedAiuMicros: 0n,
      limitAiuMicros: 100n,
    });

    const result = await new ApplicationUsageOfficialWriter().commit(
      transaction as unknown as Prisma.TransactionClient,
      context({ quota: { kind: "application_quota", reservationId: null } }),
    );

    expect(result.metrics).toMatchObject({
      consumedAiuMicros: "5",
      quotaDecision: "warn",
    });
    expect(transaction._ledgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        consumedAfterMicros: 103n,
        limitAfterMicros: 100n,
        reason: "Soft AIU limit exceeded; model call was allowed",
      }),
    });
  });

  it("reuses the immutable rating and ledger evidence on a replay", async () => {
    const transaction = baseTransaction();
    transaction.usageEventRegistry.findFirstOrThrow.mockResolvedValue({
      applicationUserId,
      reservationId: null,
    });
    transaction.applicationUsageRating.findUnique.mockResolvedValue({ id: "rating-1", modelId });
    transaction.userAiuQuota.findUnique.mockResolvedValue({
      id: quotaId,
      policyId: null,
      enabled: true,
      hardLimit: false,
      limitAiuMicros: 100n,
      lockVersion: 2,
    });
    transaction.userAiuLedgerEntry.findUnique.mockResolvedValue({ consumedDeltaMicros: 5n });

    await new ApplicationUsageOfficialWriter().commit(
      transaction as unknown as Prisma.TransactionClient,
      context({ quota: { kind: "application_quota", reservationId: null } }),
    );

    expect(transaction._ratingCreate).not.toHaveBeenCalled();
    expect(transaction.userAiuQuota.updateMany).not.toHaveBeenCalled();
    expect(transaction._ledgerCreate).not.toHaveBeenCalled();
  });

  it("rejects a reservation that does not belong to the event application and user", async () => {
    const transaction = baseTransaction();

    await expect(
      new ApplicationUsageOfficialWriter().commit(
        transaction as unknown as Prisma.TransactionClient,
        context(),
      ),
    ).rejects.toThrow("reservation is invalid");
    expect(transaction.userAiuReservation.findFirst).toHaveBeenCalledWith({
      where: { applicationId, id: reservationId, userId: applicationUserId },
      include: { quota: true },
    });
  });
});

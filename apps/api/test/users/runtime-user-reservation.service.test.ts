import { describe, expect, it, vi } from "vitest";

import {
  AiuReservationStatus,
  ApplicationUserStatus,
  QuotaPeriodType,
  type DatabaseClient,
} from "@tokenpilot/db";

import type { ApiConfiguration } from "../../src/api-config.js";
import type { AuditContextService } from "../../src/audit-context.js";
import type { AuditService } from "../../src/audit.service.js";
import { RuntimeUserReservationService } from "../../src/runtime/user-reservation.service.js";

const applicationId = "00000000-0000-4000-8000-000000000901";
const userId = "00000000-0000-4000-8000-000000000902";
const quotaId = "00000000-0000-4000-8000-000000000903";
const modelId = "00000000-0000-4000-8000-000000000904";
const now = new Date("2026-07-18T00:00:00.000Z");

function quota(overrides: Record<string, unknown> = {}) {
  return {
    id: quotaId,
    applicationId,
    userId,
    policyId: null,
    periodType: QuotaPeriodType.LIFETIME,
    periodStart: now,
    periodEnd: null,
    limitAiuMicros: 10_000_000n,
    consumedAiuMicros: 2_000_000n,
    reservedAiuMicros: 1_000_000n,
    hardLimit: true,
    enabled: true,
    lockVersion: 4,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function user(
  status: ApplicationUserStatus = ApplicationUserStatus.ACTIVE,
  currentQuota: ReturnType<typeof quota> | null = quota(),
) {
  return {
    id: userId,
    applicationId,
    externalId: "customer-42",
    name: "Ada",
    tags: [],
    propertiesJson: {},
    status,
    blockedReason: status === ApplicationUserStatus.BLOCKED ? "abuse" : null,
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    quota: currentQuota,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    user_id: "customer-42",
    display_user: "Ada",
    operation_id: "operation-42",
    virtual_model: "assistant",
    estimated_aiu_micros: "3000000",
    ...overrides,
  };
}

function fixture(
  options: {
    status?: ApplicationUserStatus;
    currentQuota?: ReturnType<typeof quota> | null;
    existing?: Record<string, unknown> | null;
  } = {},
) {
  const currentQuota = options.currentQuota === undefined ? quota() : options.currentQuota;
  const currentUser = user(options.status, currentQuota);
  const virtualFind = vi.fn().mockResolvedValue({
    id: "virtual-1",
    targets: [{ modelId }],
  });
  const upsertUser = vi.fn().mockResolvedValue(currentUser);
  const findUser = vi.fn().mockResolvedValue(currentUser);
  const findReservation = vi.fn().mockResolvedValue(options.existing ?? null);
  const quotaUpdate = vi.fn().mockResolvedValue({ count: 1 });
  const createReservation = vi.fn().mockImplementation(({ data }) =>
    Promise.resolve({
      ...data,
      id: data.id,
      settledAiuMicros: 0n,
      status: AiuReservationStatus.RESERVED,
      lockVersion: 0,
      createdAt: now,
      updatedAt: now,
      settledAt: null,
      releasedAt: null,
    }),
  );
  const createLedger = vi.fn().mockResolvedValue({ id: "ledger-1" });
  const transaction = {
    applicationUser: { findFirst: findUser },
    aiuQuotaPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    applicationUserGroup: { findMany: vi.fn().mockResolvedValue([]) },
    userAiuQuota: { findUnique: vi.fn().mockResolvedValue(currentQuota), updateMany: quotaUpdate },
    userAiuReservation: {
      findFirst: findReservation,
      create: createReservation,
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    userAiuLedgerEntry: { create: createLedger },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
  };
  const database = {
    application: { findUniqueOrThrow: vi.fn().mockResolvedValue({ timezone: "Asia/Shanghai" }) },
    virtualModel: { findFirst: virtualFind },
    applicationUser: { upsert: upsertUser },
    $transaction: vi.fn().mockImplementation((callback) => callback(transaction)),
  } as unknown as DatabaseClient;
  const context = {
    current: () => ({ applicationId, applicationSlug: "demo", actorId: "service_key:key-1" }),
  } as unknown as AuditContextService;
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const configuration = {
    aiuReservationSigningKey: "test-reservation-signing-key-at-least-32-bytes",
    aiuReservationKeyVersion: "test",
    aiuReservationTtlSeconds: 300,
  } as ApiConfiguration;
  return {
    service: new RuntimeUserReservationService(database, configuration, context, audit),
    database,
    transaction,
    virtualFind,
    upsertUser,
    quotaUpdate,
    createReservation,
    createLedger,
  };
}

describe("RuntimeUserReservationService", () => {
  it("creates or refreshes the user only inside the API key application", async () => {
    const value = fixture({ currentQuota: null });
    const result = await value.service.create(request({ user_properties: { language: "zh-CN" } }));

    expect(result).toMatchObject({
      allowed: true,
      reason: "quota_not_set",
      reservation: null,
    });
    expect(value.virtualFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: { applicationId, name: "assistant", enabled: true } }),
    );
    expect(value.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { applicationId_externalId: { applicationId, externalId: "customer-42" } },
        create: expect.objectContaining({
          applicationId,
          externalId: "customer-42",
          name: "Ada",
          propertiesJson: { language: "zh-CN" },
        }),
      }),
    );
  });

  it("denies a blocked application user before touching quota", async () => {
    const value = fixture({ status: ApplicationUserStatus.BLOCKED });
    const result = await value.service.create(request());

    expect(result).toMatchObject({ allowed: false, reason: "user_blocked" });
    expect(value.database.$transaction).not.toHaveBeenCalled();
  });

  it("denies a hard-limit reservation that exceeds remaining AIU", async () => {
    const value = fixture({
      currentQuota: quota({ limitAiuMicros: 4_000_000n }),
    });
    const result = await value.service.create(request());

    expect(result).toMatchObject({
      allowed: false,
      reason: "quota_exhausted",
      user: { remaining_aiu_micros: "1000000" },
    });
    expect(value.createReservation).not.toHaveBeenCalled();
  });

  it("atomically reserves AIU and records an immutable ledger entry", async () => {
    const value = fixture();
    const result = await value.service.create(request());

    expect(result).toMatchObject({
      allowed: true,
      reason: "reserved",
      user: { reserved_aiu_micros: "4000000", remaining_aiu_micros: "4000000" },
      reservation: { reserved_aiu_micros: "3000000" },
    });
    expect(value.quotaUpdate).toHaveBeenCalledWith({
      where: { id: quotaId, applicationId, lockVersion: 4 },
      data: { reservedAiuMicros: { increment: 3_000_000n }, lockVersion: { increment: 1 } },
    });
    expect(value.createReservation).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationId,
        userId,
        quotaId,
        operationId: "operation-42",
        virtualModel: "assistant",
        candidateModelIdsJson: [modelId],
        reservedAiuMicros: 3_000_000n,
        tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    });
    expect(value.createLedger).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationId,
        userId,
        quotaId,
        reservedDeltaMicros: 3_000_000n,
        reservedAfterMicros: 4_000_000n,
      }),
    });
  });

  it("rejects candidate model IDs outside the selected virtual model", async () => {
    const value = fixture();
    await expect(
      value.service.create(
        request({ candidate_model_ids: ["00000000-0000-4000-8000-000000000999"] }),
      ),
    ).rejects.toThrow("do not belong");
    expect(value.upsertUser).not.toHaveBeenCalled();
  });
});

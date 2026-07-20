import { describe, expect, it, vi } from "vitest";

import { AiuQuotaPolicyScope, QuotaPeriodType, type DatabaseClient } from "@tokenpilot/db";

import type { AuditContextService } from "../../src/audit-context.js";
import type { AuditService } from "../../src/audit.service.js";
import { AiuQuotaPolicyService } from "../../src/quota-policies/quota-policy.service.js";

const applicationId = "00000000-0000-4000-8000-000000000201";
const userId = "00000000-0000-4000-8000-000000000202";
const groupId = "00000000-0000-4000-8000-000000000203";
const policyId = "00000000-0000-4000-8000-000000000204";
const quotaId = "00000000-0000-4000-8000-000000000205";
const now = new Date("2026-07-18T00:00:00.000Z");

function policy(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: policyId,
    applicationId,
    scope: AiuQuotaPolicyScope.APPLICATION,
    userId: null,
    userGroupId: null,
    limitAiuMicros: 12_500_000n,
    hardLimit: false,
    periodType: QuotaPeriodType.CALENDAR_DAY,
    startsAt: null,
    endsAt: null,
    priority: 0,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    userGroup: null,
    ...overrides,
  };
}

function quota(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: quotaId,
    applicationId,
    userId,
    policyId,
    periodType: QuotaPeriodType.CALENDAR_DAY,
    periodStart: now,
    periodEnd: new Date("2026-07-19T00:00:00.000Z"),
    limitAiuMicros: 12_500_000n,
    consumedAiuMicros: 0n,
    reservedAiuMicros: 0n,
    hardLimit: false,
    enabled: true,
    lockVersion: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fixture(
  options: {
    readonly existing?: ReturnType<typeof policy> | null;
    readonly groupVersion?: number;
    readonly evaluationVersion?: number;
  } = {},
) {
  let activePolicy = options.existing ?? null;
  let currentQuota: ReturnType<typeof quota> | null =
    activePolicy === null ? null : quota({ policyId: activePolicy.id });
  const policyCreate = vi.fn().mockImplementation(({ data }) => {
    activePolicy = policy(data);
    return Promise.resolve(activePolicy);
  });
  const policyUpdate = vi.fn().mockImplementation(({ data }) => {
    activePolicy = policy({ ...activePolicy, ...data });
    return Promise.resolve(activePolicy);
  });
  const quotaCreate = vi.fn().mockImplementation(({ data }) => {
    currentQuota = quota(data);
    return Promise.resolve(currentQuota);
  });
  const quotaUpdate = vi.fn().mockImplementation(({ data }) => {
    currentQuota = quota({ ...currentQuota, ...data });
    return Promise.resolve(currentQuota);
  });
  const ledgerCreate = vi.fn().mockResolvedValue({ id: "ledger-1" });
  const transaction = {
    application: { findUniqueOrThrow: vi.fn().mockResolvedValue({ timezone: "UTC" }) },
    applicationUser: { findMany: vi.fn().mockResolvedValue([{ id: userId }]) },
    applicationUserGroup: {
      findFirst: vi.fn().mockResolvedValue({
        definitionVersion: options.groupVersion ?? 2,
        evaluations: [
          {
            definitionVersion: options.evaluationVersion ?? 2,
            members: [{ userId }],
          },
        ],
      }),
    },
    aiuQuotaPolicy: {
      findFirst: vi.fn().mockImplementation(() => Promise.resolve(activePolicy)),
      findMany: vi
        .fn()
        .mockImplementation(() => Promise.resolve(activePolicy?.enabled ? [activePolicy] : [])),
      create: policyCreate,
      update: policyUpdate,
    },
    userAiuQuota: {
      findUnique: vi.fn().mockImplementation(() => Promise.resolve(currentQuota)),
      create: quotaCreate,
      update: quotaUpdate,
    },
    userAiuReservation: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    userAiuLedgerEntry: { create: ledgerCreate },
    auditLog: {},
  };
  const database = {
    aiuQuotaPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn().mockImplementation((callback) => callback(transaction)),
  } as unknown as DatabaseClient;
  const context = {
    current: () => ({ applicationId, actorId: "user:admin" }),
  } as unknown as AuditContextService;
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return {
    transaction,
    policyCreate,
    policyUpdate,
    quotaCreate,
    quotaUpdate,
    ledgerCreate,
    audit,
    service: new AiuQuotaPolicyService(database, context, audit),
  };
}

describe("AiuQuotaPolicyService", () => {
  it("saves the application default and materializes an independent quota per user", async () => {
    const value = fixture();

    await expect(
      value.service.saveApplication({
        limit: "12.5",
        hard_limit: false,
        period: "day",
      }),
    ).resolves.toMatchObject({
      scope: "application",
      limit_aiu_micros: "12500000",
      hard_limit: false,
      period: "day",
    });

    expect(value.policyCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationId,
        scope: AiuQuotaPolicyScope.APPLICATION,
        limitAiuMicros: 12_500_000n,
      }),
    });
    expect(value.quotaCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationId,
        userId,
        policyId,
        limitAiuMicros: 12_500_000n,
        hardLimit: false,
      }),
    });
    expect(value.ledgerCreate).toHaveBeenCalled();
    expect(value.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "Updated AIU quota rule" }),
      value.transaction,
    );
  });

  it("requires a current fixed user-group snapshot before changing its quota", async () => {
    const value = fixture({ groupVersion: 3, evaluationVersion: 2 });

    await expect(
      value.service.saveUserGroup(groupId, {
        limit: "20",
        hard_limit: true,
        period: "month",
        reason: "Paid users",
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(value.policyCreate).not.toHaveBeenCalled();
    expect(value.quotaCreate).not.toHaveBeenCalled();
  });

  it("disables an application policy and its materialized quota atomically", async () => {
    const value = fixture({ existing: policy() });

    await expect(value.service.disableApplication({})).resolves.toMatchObject({ enabled: false });

    expect(value.policyUpdate).toHaveBeenCalledWith({
      where: { id: policyId },
      data: { enabled: false },
    });
    expect(value.quotaUpdate).toHaveBeenCalledWith({
      where: { id: quotaId },
      data: { policyId: null, enabled: false, lockVersion: { increment: 1 } },
    });
    expect(value.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aiu_quota_policy.disable",
        objectId: policyId,
        reason: "Removed AIU quota rule",
      }),
      value.transaction,
    );
  });
});

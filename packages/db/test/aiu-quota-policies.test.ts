import { describe, expect, it, vi } from "vitest";

import {
  aiuQuotaPeriodWindow,
  materializeEffectiveAiuQuotaPolicy,
  resolveEffectiveAiuQuotaPolicy,
  type AiuQuotaPolicyDatabase,
} from "../src/aiu-quota-policies.js";
import { AiuQuotaPolicyScope, QuotaPeriodType } from "../src/generated/prisma/enums.js";

const applicationId = "00000000-0000-4000-8000-000000000101";
const userId = "00000000-0000-4000-8000-000000000102";
const groupId = "00000000-0000-4000-8000-000000000103";
const updatedAt = new Date("2026-07-18T00:00:00.000Z");

function policy(scope: AiuQuotaPolicyScope, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: `00000000-0000-4000-8000-${scope === AiuQuotaPolicyScope.USER ? "000000000104" : scope === AiuQuotaPolicyScope.USER_GROUP ? "000000000105" : "000000000106"}`,
    applicationId,
    scope,
    userId: scope === AiuQuotaPolicyScope.USER ? userId : null,
    userGroupId: scope === AiuQuotaPolicyScope.USER_GROUP ? groupId : null,
    limitAiuMicros: 100n,
    hardLimit: false,
    periodType: QuotaPeriodType.CALENDAR_DAY,
    startsAt: null,
    endsAt: null,
    priority: 0,
    enabled: true,
    createdAt: updatedAt,
    updatedAt,
    userGroup:
      scope === AiuQuotaPolicyScope.USER_GROUP
        ? {
            definitionVersion: 3,
            evaluations: [
              {
                definitionVersion: 3,
                members: [{ userId }],
              },
            ],
          }
        : null,
    ...overrides,
  };
}

function database(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    aiuQuotaPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    applicationUserGroup: {},
    userAiuQuota: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
    },
    userAiuReservation: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    userAiuLedgerEntry: { create: vi.fn().mockResolvedValue({ id: "ledger-1" }) },
    ...overrides,
  } as unknown as AiuQuotaPolicyDatabase;
}

describe("effective AIU quota policies", () => {
  it("resolves direct user, current group, then application precedence", async () => {
    const direct = policy(AiuQuotaPolicyScope.USER);
    const group = policy(AiuQuotaPolicyScope.USER_GROUP, { priority: 10 });
    const application = policy(AiuQuotaPolicyScope.APPLICATION);
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([group, application, direct])
      .mockResolvedValueOnce([group, application])
      .mockResolvedValueOnce([
        policy(AiuQuotaPolicyScope.USER_GROUP, {
          userGroup: {
            definitionVersion: 4,
            evaluations: [{ definitionVersion: 3, members: [{ userId }] }],
          },
        }),
        application,
      ]);
    const db = database({ aiuQuotaPolicy: { findMany } });

    await expect(resolveEffectiveAiuQuotaPolicy(db, applicationId, userId)).resolves.toBe(direct);
    await expect(resolveEffectiveAiuQuotaPolicy(db, applicationId, userId)).resolves.toBe(group);
    await expect(resolveEffectiveAiuQuotaPolicy(db, applicationId, userId)).resolves.toBe(
      application,
    );
  });

  it("creates an independent per-user quota from the effective policy", async () => {
    const application = policy(AiuQuotaPolicyScope.APPLICATION, {
      limitAiuMicros: 250_000_000n,
      hardLimit: true,
    });
    const created = {
      id: "00000000-0000-4000-8000-000000000107",
      applicationId,
      userId,
      policyId: application.id,
      periodType: QuotaPeriodType.CALENDAR_DAY,
      periodStart: new Date("2026-07-18T00:00:00.000Z"),
      periodEnd: new Date("2026-07-19T00:00:00.000Z"),
      limitAiuMicros: 250_000_000n,
      consumedAiuMicros: 0n,
      reservedAiuMicros: 0n,
      hardLimit: true,
      enabled: true,
      lockVersion: 0,
    };
    const create = vi.fn().mockResolvedValue(created);
    const ledgerCreate = vi.fn().mockResolvedValue({ id: "ledger-1" });
    const db = database({
      aiuQuotaPolicy: { findMany: vi.fn().mockResolvedValue([application]) },
      userAiuQuota: { findUnique: vi.fn().mockResolvedValue(null), create, update: vi.fn() },
      userAiuLedgerEntry: { create: ledgerCreate },
    });
    const window = {
      start: new Date("2026-07-18T00:00:00.000Z"),
      end: new Date("2026-07-19T00:00:00.000Z"),
    };

    await expect(
      materializeEffectiveAiuQuotaPolicy(db, {
        applicationId,
        userId,
        reason: "Applied application default",
        window: () => window,
      }),
    ).resolves.toBe(created);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationId,
        userId,
        policyId: application.id,
        limitAiuMicros: 250_000_000n,
        hardLimit: true,
        periodStart: window.start,
        periodEnd: window.end,
      }),
    });
    expect(ledgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationId,
        userId,
        quotaId: created.id,
        consumedAfterMicros: 0,
        reservedAfterMicros: 0,
        limitAfterMicros: 250_000_000n,
      }),
    });
  });

  it("renews calendar quotas and releases stale reservations at the boundary", async () => {
    const application = policy(AiuQuotaPolicyScope.APPLICATION);
    const current = {
      id: "00000000-0000-4000-8000-000000000108",
      applicationId,
      userId,
      policyId: application.id,
      periodType: QuotaPeriodType.CALENDAR_DAY,
      periodStart: new Date("2026-07-17T00:00:00.000Z"),
      periodEnd: new Date("2026-07-18T00:00:00.000Z"),
      limitAiuMicros: 100n,
      consumedAiuMicros: 75n,
      reservedAiuMicros: 10n,
      hardLimit: false,
      enabled: true,
      lockVersion: 2,
    };
    const updated = {
      ...current,
      periodStart: new Date("2026-07-18T00:00:00.000Z"),
      periodEnd: new Date("2026-07-19T00:00:00.000Z"),
      consumedAiuMicros: 0n,
      reservedAiuMicros: 0n,
    };
    const update = vi.fn().mockResolvedValue(updated);
    const reservationUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const ledgerCreate = vi.fn().mockResolvedValue({ id: "ledger-2" });
    const db = database({
      aiuQuotaPolicy: { findMany: vi.fn().mockResolvedValue([application]) },
      userAiuQuota: { findUnique: vi.fn().mockResolvedValue(current), create: vi.fn(), update },
      userAiuReservation: { updateMany: reservationUpdate },
      userAiuLedgerEntry: { create: ledgerCreate },
    });

    await materializeEffectiveAiuQuotaPolicy(db, {
      applicationId,
      userId,
      reason: "New calendar day",
      window: () => aiuQuotaPeriodWindow(QuotaPeriodType.CALENDAR_DAY, "UTC", updatedAt),
    });

    expect(reservationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "RELEASED" }) }),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: current.id },
      data: expect.objectContaining({
        consumedAiuMicros: 0n,
        reservedAiuMicros: 0n,
        periodStart: updated.periodStart,
        periodEnd: updated.periodEnd,
      }),
    });
    expect(ledgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        consumedDeltaMicros: -75n,
        reservedDeltaMicros: -10n,
        consumedAfterMicros: 0n,
        reservedAfterMicros: 0n,
      }),
    });
  });

  it("disables only a quota materialized from a removed policy", async () => {
    const current = {
      id: "00000000-0000-4000-8000-000000000109",
      applicationId,
      userId,
      policyId: "00000000-0000-4000-8000-000000000106",
      enabled: true,
      consumedAiuMicros: 30n,
      reservedAiuMicros: 0n,
      limitAiuMicros: 100n,
    };
    const update = vi.fn().mockResolvedValue({ ...current, policyId: null, enabled: false });
    const db = database({
      userAiuQuota: { findUnique: vi.fn().mockResolvedValue(current), create: vi.fn(), update },
    });

    await materializeEffectiveAiuQuotaPolicy(db, {
      applicationId,
      userId,
      reason: "Removed application default",
      window: () => ({ start: updatedAt, end: null }),
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: current.id },
      data: { policyId: null, enabled: false, lockVersion: { increment: 1 } },
    });
  });
});

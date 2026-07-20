import { describe, expect, it, vi } from "vitest";

import {
  ApplicationUserStatus,
  Prisma,
  QuotaPeriodType,
  type DatabaseClient,
} from "@tokenpilot/db";

import type { AuditContextService } from "../../src/audit-context.js";
import type { AuditService } from "../../src/audit.service.js";
import type { RuntimeAccessSnapshotService } from "../../src/runtime-configuration/runtime-access-snapshot.service.js";
import { ApplicationUserService } from "../../src/users/user.service.js";
import type { ApplicationUserMetricsRepository } from "../../src/users/user-metrics.repository.js";
import { ApplicationUserQuotaService } from "../../src/users/user-quota.service.js";

const applicationId = "00000000-0000-4000-8000-000000000811";
const userId = "00000000-0000-4000-8000-000000000812";
const quotaId = "00000000-0000-4000-8000-000000000813";
const groupId = "00000000-0000-4000-8000-000000000814";
const now = new Date("2026-07-18T00:00:00.000Z");

function user(quota: Record<string, unknown> | null = null) {
  return {
    id: userId,
    applicationId,
    externalId: "user-42",
    name: "Ada",
    tags: ["paid"],
    propertiesJson: { member_level: "pro" },
    status: ApplicationUserStatus.ACTIVE,
    blockedReason: null,
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    quota,
  };
}

function quota(overrides: Record<string, unknown> = {}) {
  return {
    id: quotaId,
    applicationId,
    userId,
    periodType: QuotaPeriodType.LIFETIME,
    periodStart: now,
    periodEnd: null,
    limitAiuMicros: 10_000_000n,
    consumedAiuMicros: 2_000_000n,
    reservedAiuMicros: 1_000_000n,
    hardLimit: true,
    enabled: true,
    lockVersion: 3,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fixture(
  initialQuota: ReturnType<typeof quota> | null = null,
  scopedApplicationId = applicationId,
) {
  let currentQuota = initialQuota;
  const createUser = vi.fn().mockResolvedValue(user());
  const updateUser = vi
    .fn()
    .mockImplementation(({ data }: { data: { name?: string | null } }) =>
      Promise.resolve({ ...user(), name: data.name ?? "Ada" }),
    );
  const findFirst = vi.fn().mockImplementation(() => Promise.resolve(user(currentQuota)));
  const findMany = vi.fn().mockResolvedValue([user(currentQuota)]);
  const count = vi.fn().mockResolvedValue(1);
  const quotaAggregate = vi.fn().mockResolvedValue({
    _sum: {
      limitAiuMicros: 10_000_000n,
      consumedAiuMicros: 2_000_000n,
      reservedAiuMicros: 1_000_000n,
    },
  });
  const quotaUpsert = vi.fn().mockImplementation(({ create, update }) => {
    currentQuota = {
      ...quota(),
      ...(currentQuota === null ? create : update),
      limitAiuMicros: create.limitAiuMicros,
      consumedAiuMicros: currentQuota?.consumedAiuMicros ?? 0n,
      reservedAiuMicros: currentQuota?.reservedAiuMicros ?? 0n,
    };
    return Promise.resolve(currentQuota);
  });
  const quotaPolicyUpsert = vi
    .fn()
    .mockResolvedValue({ id: "00000000-0000-4000-8000-000000000815" });
  const quotaUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const reservationUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  const ledgerCreate = vi.fn().mockResolvedValue({ id: "ledger-1" });
  const profileOutboxCreate = vi.fn().mockResolvedValue({ id: 1n });
  const propertyDefinitionFindFirst = vi.fn().mockResolvedValue(null);
  const applicationUserGroupFindFirst = vi.fn().mockResolvedValue(null);
  const transaction = {
    applicationUser: { create: createUser, update: updateUser },
    propertyDefinition: { findMany: vi.fn().mockResolvedValue([]) },
    pipelineOutbox: { create: profileOutboxCreate },
    aiuQuotaPolicy: { upsert: quotaPolicyUpsert },
    userAiuQuota: { upsert: quotaUpsert, updateMany: quotaUpdateMany },
    userAiuReservation: { updateMany: reservationUpdateMany },
    userAiuLedgerEntry: { create: ledgerCreate },
  };
  const database = {
    application: { findUniqueOrThrow: vi.fn().mockResolvedValue({ timezone: "Asia/Shanghai" }) },
    applicationUser: { create: createUser, findFirst, findMany, count, update: updateUser },
    propertyDefinition: { findFirst: propertyDefinitionFindFirst },
    applicationUserGroup: { findFirst: applicationUserGroupFindFirst },
    applicationUsageRating: { groupBy: vi.fn().mockResolvedValue([]) },
    userAiuQuota: { aggregate: quotaAggregate },
    userAiuLedgerEntry: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn().mockImplementation((callback) => callback(transaction)),
  } as unknown as DatabaseClient;
  const context = {
    current: () => ({
      applicationId: scopedApplicationId,
      applicationSlug: "demo",
      actorId: "user:admin",
    }),
  } as unknown as AuditContextService;
  const audit = { record: vi.fn() } as unknown as AuditService;
  const metrics = {
    search: vi.fn().mockResolvedValue({
      rows: [
        {
          id: userId,
          externalId: "user-42",
          metrics: {
            calls: 3,
            tokens: new Prisma.Decimal(1200),
            aiuMicros: 2_500_000n,
            cost: new Prisma.Decimal("0.75"),
          },
        },
      ],
      total: 1,
    }),
    load: vi.fn().mockResolvedValue(new Map()),
    detail: vi.fn().mockResolvedValue({
      trend: [],
      models: [],
      costs: [],
      recent_calls: [],
    }),
  } as unknown as ApplicationUserMetricsRepository;
  const accessSnapshots = {
    publishWithin: vi.fn().mockResolvedValue({ version: 2 }),
  } as unknown as RuntimeAccessSnapshotService;
  const quotas = new ApplicationUserQuotaService(database, context, audit);
  return {
    database,
    createUser,
    updateUser,
    findFirst,
    findMany,
    count,
    propertyDefinitionFindFirst,
    applicationUserGroupFindFirst,
    quotaAggregate,
    quotaUpsert,
    quotaPolicyUpsert,
    quotaUpdateMany,
    reservationUpdateMany,
    ledgerCreate,
    profileOutboxCreate,
    metrics,
    accessSnapshots,
    service: new ApplicationUserService(database, context, audit, metrics, accessSnapshots, quotas),
  };
}

describe("ApplicationUserService", () => {
  it("manually creates a user inside the authenticated application", async () => {
    const value = fixture();
    const result = await value.service.create({
      user_id: "user-42",
      display_user: "Ada",
      tags: ["paid", "paid"],
      properties: { member_level: "pro" },
    });

    expect(result).toMatchObject({
      user_id: "user-42",
      display_user: "Ada",
      quota: { limit_aiu_micros: "0", remaining_aiu_micros: "0" },
    });
    expect(value.createUser).toHaveBeenCalledWith({
      data: {
        applicationId,
        externalId: "user-42",
        name: "Ada",
        tags: ["paid"],
        propertiesJson: { member_level: "pro" },
      },
      include: { quota: true },
    });
    expect(value.profileOutboxCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationId,
        aggregateType: "application_user",
        aggregateId: userId,
        eventType: "application_user.profile",
      }),
      select: { id: true },
    });
  });

  it("requires only user_id when an administrator adds a user", async () => {
    const value = fixture();

    await value.service.create({ user_id: "user-without-name" });

    expect(value.createUser).toHaveBeenCalledWith({
      data: {
        applicationId,
        externalId: "user-without-name",
        tags: [],
        propertiesJson: {},
      },
      include: { quota: true },
    });
  });

  it("allows the same user_id to be created independently in two applications", async () => {
    const otherApplicationId = "00000000-0000-4000-8000-000000000899";
    const first = fixture(null, applicationId);
    const second = fixture(null, otherApplicationId);

    await first.service.create({ user_id: "shared-user" });
    await second.service.create({ user_id: "shared-user" });

    expect(first.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ applicationId, externalId: "shared-user" }),
      }),
    );
    expect(second.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          applicationId: otherApplicationId,
          externalId: "shared-user",
        }),
      }),
    );
  });

  it("binds search, status, and exact-tag filters to the current application", async () => {
    const value = fixture(quota());
    const result = await value.service.list({ search: "Ada", status: "blocked", tag: "paid" });

    expect(result).toMatchObject({ total: 1, users: [{ user_id: "user-42" }] });
    expect(value.metrics.search).toHaveBeenCalledWith(applicationId, {
      page: 1,
      limit: 25,
      search: "Ada",
      status: "blocked",
      tag: "paid",
    });
    expect(value.findMany).toHaveBeenCalledWith({
      where: { applicationId, id: { in: [userId] } },
      include: { quota: true },
    });
    expect(result.users[0]?.usage).toEqual({
      calls: 3,
      tokens: "1200",
      aiu_micros: "2500000",
    });
  });

  it("validates a searchable user field and forwards typed usage thresholds", async () => {
    const value = fixture(quota());
    value.propertyDefinitionFindFirst.mockResolvedValue({ key: "member_level", dataType: "ENUM" });

    await value.service.list({
      min_calls: "3",
      min_tokens: "1000.5",
      min_aiu: "2.5",
      property_key: "member_level",
      property_value: "pro",
    });

    expect(value.propertyDefinitionFindFirst).toHaveBeenCalledWith({
      where: {
        applicationId,
        key: "member_level",
        scope: "USER",
        status: "ACTIVE",
        searchable: true,
        sensitive: false,
      },
      select: { key: true, dataType: true },
    });
    expect(value.metrics.search).toHaveBeenCalledWith(applicationId, {
      page: 1,
      limit: 25,
      minimumCalls: 3,
      minimumTokens: "1000.5",
      minimumAiuMicros: 2_500_000n,
      property: { key: "member_level", dataType: "ENUM", value: "pro" },
    });
  });

  it("filters a current group by external user IDs from its fixed member snapshot", async () => {
    const value = fixture(quota());
    value.applicationUserGroupFindFirst.mockResolvedValue({
      definitionVersion: 4,
      evaluations: [
        {
          definitionVersion: 4,
          members: [{ user: { externalId: "user-42" } }],
        },
      ],
    });

    await value.service.list({ group_id: groupId });

    expect(value.metrics.search).toHaveBeenCalledWith(applicationId, {
      page: 1,
      limit: 25,
      externalUserIds: ["user-42"],
    });
  });

  it("updates display_user while keeping the application user ID immutable", async () => {
    const value = fixture();
    const result = await value.service.update(userId, { display_user: "Ada Byron" });

    expect(value.updateUser).toHaveBeenCalledWith({
      where: { id: userId },
      data: { name: "Ada Byron" },
      include: { quota: true },
    });
    expect(result).toMatchObject({ id: userId, user_id: "user-42", display_user: "Ada Byron" });
  });

  it("publishes the updated access snapshot in the same transaction when a user is stopped", async () => {
    const value = fixture();

    await value.service.update(userId, { blocked: true, reason: "Abuse review" });

    expect(value.accessSnapshots.publishWithin).toHaveBeenCalledWith(
      expect.objectContaining({ applicationUser: expect.any(Object) }),
      {
        applicationId,
        actorId: "user:admin",
        reason: "Abuse review",
      },
    );
  });

  it("summarizes users and quota only inside the current application", async () => {
    const value = fixture(quota());
    const result = await value.service.summary();

    expect(result).toEqual({
      total_users: 1,
      blocked_users: 1,
      limit_aiu_micros: "10000000",
      used_aiu_micros: "2000000",
      reserved_aiu_micros: "1000000",
      remaining_aiu_micros: "7000000",
    });
    expect(value.count).toHaveBeenNthCalledWith(1, { where: { applicationId } });
    expect(value.count).toHaveBeenNthCalledWith(2, {
      where: { applicationId, status: ApplicationUserStatus.BLOCKED },
    });
    expect(value.quotaAggregate).toHaveBeenCalledWith({
      where: { applicationId, enabled: true },
      _sum: {
        limitAiuMicros: true,
        consumedAiuMicros: true,
        reservedAiuMicros: true,
      },
    });
  });

  it("loads user analytics from ClickHouse and operations from the scoped audit log", async () => {
    const value = fixture(quota());
    const result = await value.service.analytics(userId, {
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-31T00:00:00.000Z",
    });

    expect(value.metrics.detail).toHaveBeenCalledWith(
      applicationId,
      "user-42",
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-07-31T00:00:00.000Z"),
    );
    expect(result).toMatchObject({
      trend: [],
      models: [],
      costs: [],
      recent_calls: [],
      operations: [],
    });
  });

  it("uses the application-scoped quota identity", async () => {
    const value = fixture();
    await value.service.saveQuota(userId, {
      limit: "5",
      hard_limit: false,
      period: "lifetime",
    });

    expect(value.quotaUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { applicationId_userId: { applicationId, userId } },
        create: expect.objectContaining({ policyId: "00000000-0000-4000-8000-000000000815" }),
      }),
    );
  });

  it("stores an AIU decimal as integer micro-units", async () => {
    const value = fixture();
    const result = await value.service.saveQuota(userId, {
      limit: "12.500001",
      hard_limit: true,
      period: "lifetime",
    });

    expect(value.quotaUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          applicationId,
          userId,
          limitAiuMicros: 12_500_001n,
          hardLimit: true,
        }),
      }),
    );
    expect(result.quota.limit_aiu_micros).toBe("12500001");
  });

  it("resets used and reserved AIU while appending an immutable adjustment", async () => {
    const current = quota();
    const value = fixture(current);
    await value.service.resetQuota(userId, { reason: "Customer renewal" });

    expect(value.reservationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ applicationId, userId, status: "RESERVED" }),
        data: expect.objectContaining({ status: "RELEASED" }),
      }),
    );
    expect(value.quotaUpdateMany).toHaveBeenCalledWith({
      where: { id: quotaId, applicationId, lockVersion: 3 },
      data: expect.objectContaining({
        consumedAiuMicros: 0,
        reservedAiuMicros: 0,
        lockVersion: { increment: 1 },
      }),
    });
    expect(value.ledgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationId,
        userId,
        quotaId,
        consumedDeltaMicros: -2_000_000n,
        reservedDeltaMicros: -1_000_000n,
        reason: "Customer renewal",
      }),
    });
  });
});

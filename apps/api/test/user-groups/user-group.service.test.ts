import { describe, expect, it, vi } from "vitest";

import { AiuQuotaPolicyScope, Prisma, QuotaPeriodType, type DatabaseClient } from "@tokenpilot/db";

import type { AuditContextService } from "../../src/audit-context.js";
import type { AuditService } from "../../src/audit.service.js";
import type { UserGroupCandidateRepository } from "../../src/user-groups/user-group-candidates.js";
import { ApplicationUserGroupService } from "../../src/user-groups/user-group.service.js";

const applicationId = "00000000-0000-4000-8000-000000000301";
const groupId = "00000000-0000-4000-8000-000000000302";
const previousEvaluationId = "00000000-0000-4000-8000-000000000303";
const nextEvaluationId = "00000000-0000-4000-8000-000000000304";
const oldUserId = "00000000-0000-4000-8000-000000000305";
const newUserId = "00000000-0000-4000-8000-000000000306";
const groupPolicyId = "00000000-0000-4000-8000-000000000307";
const applicationPolicyId = "00000000-0000-4000-8000-000000000308";
const now = new Date("2026-07-18T10:00:00.000Z");

function effectivePolicy(scope: AiuQuotaPolicyScope, userId: string) {
  const isGroup = scope === AiuQuotaPolicyScope.USER_GROUP;
  return {
    id: isGroup ? groupPolicyId : applicationPolicyId,
    applicationId,
    scope,
    userId: null,
    userGroupId: isGroup ? groupId : null,
    limitAiuMicros: isGroup ? 20_000_000n : 5_000_000n,
    hardLimit: isGroup,
    periodType: QuotaPeriodType.CALENDAR_DAY,
    startsAt: null,
    endsAt: null,
    priority: isGroup ? 10 : 0,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    userGroup: isGroup
      ? {
          definitionVersion: 2,
          evaluations: [
            {
              definitionVersion: 2,
              members: userId === newUserId ? [{ userId }] : [],
            },
          ],
        }
      : null,
  };
}

describe("ApplicationUserGroupService", () => {
  it("rematerializes users entering and leaving a group quota after refresh", async () => {
    const group = {
      id: groupId,
      applicationId,
      name: "Paid users",
      description: null,
      definitionJson: {
        match: "all",
        conditions: [{ field: "tag", operator: "equals", value: "paid" }],
      },
      definitionVersion: 2,
      refreshMinutes: 15,
      enabled: true,
      lastEvaluatedAt: now,
      createdAt: now,
      updatedAt: now,
      evaluations: [
        {
          id: previousEvaluationId,
          definitionVersion: 2,
          memberCount: 1,
          evaluatedAt: now,
        },
      ],
    };
    const quotaUpdate = vi.fn().mockImplementation(({ data }) => Promise.resolve(data));
    const quotaCreate = vi.fn().mockImplementation(({ data }) =>
      Promise.resolve({
        id: `quota-${data.userId}`,
        consumedAiuMicros: 0n,
        reservedAiuMicros: 0n,
        ...data,
      }),
    );
    const quotaRows = new Map([
      [
        oldUserId,
        {
          id: "quota-old",
          applicationId,
          userId: oldUserId,
          policyId: groupPolicyId,
          periodType: QuotaPeriodType.CALENDAR_DAY,
          periodStart: new Date("2026-07-18T00:00:00.000Z"),
          periodEnd: new Date("2026-07-19T00:00:00.000Z"),
          limitAiuMicros: 20_000_000n,
          consumedAiuMicros: 2_000_000n,
          reservedAiuMicros: 0n,
          hardLimit: true,
          enabled: true,
          lockVersion: 1,
        },
      ],
    ]);
    const transaction = {
      applicationUserGroupEvaluation: {
        create: vi.fn().mockResolvedValue({ id: nextEvaluationId }),
      },
      applicationUserGroupMember: {
        findMany: vi.fn().mockResolvedValue([{ userId: oldUserId }]),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      applicationUserGroup: { update: vi.fn().mockResolvedValue({}) },
      aiuQuotaPolicy: {
        findFirst: vi.fn().mockResolvedValue({ id: groupPolicyId }),
        findMany: vi.fn().mockImplementation(({ where }) => {
          const direct = where.OR[0];
          const requestedUserId = direct.userId as string;
          return Promise.resolve([
            effectivePolicy(AiuQuotaPolicyScope.USER_GROUP, requestedUserId),
            effectivePolicy(AiuQuotaPolicyScope.APPLICATION, requestedUserId),
          ]);
        }),
      },
      application: { findUniqueOrThrow: vi.fn().mockResolvedValue({ timezone: "UTC" }) },
      userAiuQuota: {
        findUnique: vi
          .fn()
          .mockImplementation(({ where }) =>
            Promise.resolve(quotaRows.get(where.applicationId_userId.userId) ?? null),
          ),
        create: quotaCreate,
        update: quotaUpdate,
      },
      userAiuReservation: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      userAiuLedgerEntry: { create: vi.fn().mockResolvedValue({ id: "ledger" }) },
    };
    const database = {
      applicationUserGroup: { findFirst: vi.fn().mockResolvedValue(group) },
      $transaction: vi.fn().mockImplementation((callback) => callback(transaction)),
    } as unknown as DatabaseClient;
    const context = {
      current: () => ({ applicationId, actorId: "user:admin" }),
    } as unknown as AuditContextService;
    const audit = { record: vi.fn() } as unknown as AuditService;
    const candidates = {
      load: vi.fn().mockResolvedValue([
        {
          id: newUserId,
          externalId: "user-new",
          name: "Ada",
          tags: ["paid"],
          propertiesJson: {},
          status: "ACTIVE",
          lastSeenAt: now,
          quota: null,
          metrics: {
            calls: 1,
            tokens: new Prisma.Decimal(10),
            aiuMicros: 0n,
            cost: new Prisma.Decimal(0),
          },
        },
      ]),
    } as unknown as UserGroupCandidateRepository;

    const result = await new ApplicationUserGroupService(
      database,
      context,
      audit,
      candidates,
    ).evaluate(groupId, now);

    expect(result).toMatchObject({
      evaluation_id: nextEvaluationId,
      member_count: 1,
      evaluated_at: "2026-07-18T10:00:00.001Z",
    });
    expect(quotaUpdate).toHaveBeenCalledWith({
      where: { id: "quota-old" },
      data: expect.objectContaining({
        policyId: applicationPolicyId,
        limitAiuMicros: 5_000_000n,
        hardLimit: false,
      }),
    });
    expect(quotaCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationId,
        userId: newUserId,
        policyId: groupPolicyId,
        limitAiuMicros: 20_000_000n,
        hardLimit: true,
      }),
    });
  });
});

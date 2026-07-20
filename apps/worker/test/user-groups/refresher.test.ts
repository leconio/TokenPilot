import { describe, expect, it, vi } from "vitest";

import type { ClickHouseClient } from "@tokenpilot/clickhouse";
import type { DatabaseClient } from "@tokenpilot/db";
import type { Redis } from "ioredis";

import { UserGroupRefresher } from "../../src/user-groups/refresher.js";

describe("UserGroupRefresher", () => {
  it("refreshes due groups under an application-prefixed Redis lock", async () => {
    const now = new Date("2026-07-18T08:00:00.000Z");
    const applicationId = "00000000-0000-4000-8000-000000000801";
    const groupId = "00000000-0000-4000-8000-000000000802";
    const evaluationId = "00000000-0000-4000-8000-000000000803";
    const group = {
      id: groupId,
      applicationId,
      name: "活跃用户",
      description: null,
      definitionJson: {
        match: "all",
        conditions: [{ field: "status", operator: "equals", value: "active" }],
      },
      definitionVersion: 4,
      refreshMinutes: 5,
      enabled: true,
      lastEvaluatedAt: new Date("2026-07-18T07:50:00.000Z"),
      createdAt: now,
      updatedAt: now,
    };
    const transaction = {
      applicationUserGroup: {
        findFirst: vi.fn().mockResolvedValue({ definitionVersion: 4 }),
        update: vi.fn().mockResolvedValue({}),
      },
      applicationUserGroupEvaluation: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: evaluationId }),
      },
      applicationUserGroupMember: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn(),
      },
      aiuQuotaPolicy: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const database = {
      applicationUserGroup: { findMany: vi.fn().mockResolvedValue([group]) },
      applicationUser: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn().mockImplementation((action) => action(transaction)),
    } as unknown as DatabaseClient;
    const redis = {
      set: vi.fn().mockResolvedValue("OK"),
      eval: vi.fn().mockResolvedValue(1),
    } as unknown as Redis;
    const logger = { info: vi.fn(), error: vi.fn() };
    const clickhouse = {
      query: vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue([]) }),
    } as unknown as ClickHouseClient;

    await expect(
      new UserGroupRefresher(database, clickhouse, redis, logger).refreshDue(10, now),
    ).resolves.toEqual({ due: 1, refreshed: 1, failed: 0 });

    expect(redis.set).toHaveBeenCalledWith(
      `app:${applicationId}:user-group:${groupId}:refresh`,
      expect.any(String),
      "PX",
      300_000,
      "NX",
    );
    expect(transaction.applicationUserGroupEvaluation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationId,
        groupId,
        definitionVersion: 4,
        memberCount: 0,
        evaluatedAt: now,
      }),
    });
    expect(transaction.applicationUserGroupMember.createMany).not.toHaveBeenCalled();
    expect(redis.eval).toHaveBeenCalledOnce();
  });
});

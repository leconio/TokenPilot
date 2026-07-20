import { describe, expect, it, vi } from "vitest";

import type { DatabaseClient } from "@tokenpilot/db";

import type { AuditContextService } from "../../src/audit-context.js";
import type { AuditService } from "../../src/audit.service.js";
import type { RuntimeAccessSnapshotService } from "../../src/runtime-configuration/runtime-access-snapshot.service.js";
import { ApplicationUserGroupActionsService } from "../../src/user-groups/user-group-actions.service.js";

const applicationId = "00000000-0000-4000-8000-000000000721";
const groupId = "00000000-0000-4000-8000-000000000722";
const evaluationId = "00000000-0000-4000-8000-000000000723";
const userId = "00000000-0000-4000-8000-000000000724";
const now = new Date("2026-07-18T12:00:00.000Z");

function applicationUser() {
  return {
    id: userId,
    applicationId,
    externalId: "user-42",
    name: "Ada",
    tags: ["paid"],
    propertiesJson: {},
    status: "BLOCKED",
    blockedReason: "Abuse review",
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    quota: null,
  };
}

function fixture(definitionVersion = 2, evaluationVersion = 2) {
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const transaction = {
    applicationUser: {
      updateMany,
      findMany: vi.fn().mockResolvedValue([applicationUser()]),
    },
    applicationUserGroupBulkAction: {
      create: vi.fn().mockResolvedValue({ id: "00000000-0000-4000-8000-000000000725" }),
    },
    propertyDefinition: { findMany: vi.fn().mockResolvedValue([]) },
    pipelineOutbox: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const database = {
    applicationUserGroup: {
      findFirst: vi.fn().mockResolvedValue({
        id: groupId,
        definitionVersion,
        evaluations: [
          {
            id: evaluationId,
            definitionVersion: evaluationVersion,
            members: [{ userId, user: applicationUser() }],
          },
        ],
      }),
    },
    $transaction: vi.fn().mockImplementation((callback) => callback(transaction)),
  } as unknown as DatabaseClient;
  const context = {
    current: () => ({ applicationId, actorId: "user:admin" }),
  } as unknown as AuditContextService;
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const publishWithin = vi.fn().mockResolvedValue({ version: 4 });
  const access = { publishWithin } as unknown as RuntimeAccessSnapshotService;
  return {
    transaction,
    updateMany,
    publishWithin,
    service: new ApplicationUserGroupActionsService(database, context, audit, access),
  };
}

describe("ApplicationUserGroupActionsService", () => {
  it("publishes one access snapshot atomically after blocking the fixed member snapshot", async () => {
    const value = fixture();

    await expect(
      value.service.run(groupId, { action: "block", reason: "Abuse review" }, now),
    ).resolves.toMatchObject({ target_count: 1, success_count: 1, failure_count: 0 });

    expect(value.updateMany).toHaveBeenCalledWith({
      where: { applicationId, id: { in: [userId] } },
      data: { status: "BLOCKED", blockedReason: "Abuse review" },
    });
    expect(value.publishWithin).toHaveBeenCalledWith(value.transaction, {
      applicationId,
      actorId: "user:admin",
      reason: "Abuse review",
      now,
    });
  });

  it("refuses a stale member snapshot before changing any user", async () => {
    const value = fixture(3, 2);
    await expect(
      value.service.run(groupId, { action: "block", reason: "Abuse review" }, now),
    ).rejects.toMatchObject({ status: 400 });
    expect(value.updateMany).not.toHaveBeenCalled();
    expect(value.publishWithin).not.toHaveBeenCalled();
  });
});

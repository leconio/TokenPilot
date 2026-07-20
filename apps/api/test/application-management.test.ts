import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import {
  ApplicationRole,
  ApplicationStatus,
  defaultApplicationPermissions,
  type DatabaseClient,
} from "@tokenpilot/db";

import type { AuditService } from "../src/audit.service.js";
import { ApplicationMembersService } from "../src/applications/application-members.service.js";
import { ApplicationService } from "../src/applications/application.service.js";
import type { RuntimeAccessSnapshotService } from "../src/runtime-configuration/runtime-access-snapshot.service.js";
import type { WebAuthService } from "../src/web-auth.service.js";

const applicationId = "00000000-0000-4000-8000-000000000401";
const request = { headers: { cookie: "session=test" } } as never;

function webAuth(userId = "owner-1") {
  return {
    authenticate: vi.fn().mockResolvedValue({ userId, sessionId: "session-1" }),
  } as unknown as WebAuthService;
}

function application(
  role: ApplicationRole = ApplicationRole.OWNER,
  permissions: readonly string[] = defaultApplicationPermissions(role),
) {
  return {
    id: applicationId,
    name: "Support",
    slug: "support",
    status: ApplicationStatus.ACTIVE,
    timezone: "UTC",
    baseCurrency: "USD",
    settings: {},
    members: [{ userId: "owner-1", role, permissions }],
  };
}

describe("application archive", () => {
  it("requires exact name confirmation before changing state", async () => {
    const transaction = vi.fn();
    const database = {
      application: { findFirst: vi.fn().mockResolvedValue(application()) },
      $transaction: transaction,
    } as unknown as DatabaseClient;
    const service = new ApplicationService(
      database,
      webAuth(),
      {
        record: vi.fn(),
      } as unknown as AuditService,
      {} as RuntimeAccessSnapshotService,
    );

    await expect(
      service.archive(request, "support", {
        confirmation_name: "support",
        reason: "No longer used",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("atomically disables the app and writes non-deleting audit evidence", async () => {
    const transaction = { application: { update: vi.fn().mockResolvedValue({}) } };
    const database = {
      application: { findFirst: vi.fn().mockResolvedValue(application()) },
      $transaction: vi.fn().mockImplementation((callback) => callback(transaction)),
    } as unknown as DatabaseClient;
    const record = vi.fn().mockResolvedValue(undefined);
    const publishWithin = vi.fn().mockResolvedValue({ version: 2 });
    const service = new ApplicationService(
      database,
      webAuth(),
      {
        record,
      } as unknown as AuditService,
      {
        publishWithin,
      } as unknown as RuntimeAccessSnapshotService,
    );

    await expect(
      service.archive(request, "support", {
        confirmation_name: "Support",
        reason: "Product was retired",
      }),
    ).resolves.toEqual({
      archived: true,
      status: "disabled",
      historical_data_retained: true,
    });
    expect(transaction.application.update).toHaveBeenCalledWith({
      where: { id: applicationId },
      data: { status: ApplicationStatus.DISABLED, archivedAt: expect.any(Date) },
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "application.archive",
        reason: "Product was retired",
        after: expect.objectContaining({ deletion_performed: false }),
      }),
      transaction,
    );
    expect(publishWithin).toHaveBeenCalledWith(transaction, {
      applicationId,
      actorId: "user:owner-1",
      reason: "Product was retired",
    });
  });
});

describe("application pause", () => {
  it("publishes the paused runtime policy in the application update transaction", async () => {
    const updated = { ...application(), status: ApplicationStatus.DISABLED, archivedAt: null };
    const transaction = { application: { update: vi.fn().mockResolvedValue(updated) } };
    const database = {
      application: { findFirst: vi.fn().mockResolvedValue({ ...application(), archivedAt: null }) },
      $transaction: vi.fn().mockImplementation((callback) => callback(transaction)),
    } as unknown as DatabaseClient;
    const publishWithin = vi.fn().mockResolvedValue({ version: 4 });
    const service = new ApplicationService(
      database,
      webAuth(),
      { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService,
      { publishWithin } as unknown as RuntimeAccessSnapshotService,
    );

    await expect(service.update(request, "support", { status: "disabled" })).resolves.toMatchObject(
      {
        status: "disabled",
      },
    );
    expect(publishWithin).toHaveBeenCalledWith(transaction, {
      applicationId,
      actorId: "user:owner-1",
      reason: "Paused application",
    });
  });
});

describe("application members", () => {
  it("scopes member lists to the authenticated application", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new ApplicationMembersService(
      {
        application: { findFirst: vi.fn().mockResolvedValue(application()) },
        applicationMember: { findMany },
      } as unknown as DatabaseClient,
      webAuth(),
      {} as AuditService,
    );

    await expect(service.list(request, "support")).resolves.toEqual({ members: [] });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { applicationId } }));
  });

  it("persists the selected role defaults when an owner adds a member", async () => {
    const createdAt = new Date("2026-07-18T00:00:00.000Z");
    const create = vi.fn().mockImplementation(({ data }) => ({
      ...data,
      createdAt,
      user: { name: "Reader", email: "reader@example.test" },
    }));
    const transaction = { applicationMember: { create } };
    const database = {
      application: { findFirst: vi.fn().mockResolvedValue(application()) },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: "reader-1",
          name: "Reader",
          email: "reader@example.test",
        }),
      },
      $transaction: vi.fn().mockImplementation((callback) => callback(transaction)),
    } as unknown as DatabaseClient;
    const record = vi.fn().mockResolvedValue(undefined);
    const service = new ApplicationMembersService(database, webAuth(), {
      record,
    } as unknown as AuditService);

    const result = await service.create(request, "support", {
      email: "reader@example.test",
      role: "viewer",
    });
    expect(result.permissions).toContain("reports:read");
    expect(result.permissions).not.toContain("admin:write");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ applicationId, userId: "reader-1" }),
      }),
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "application.member.create", applicationId }),
      transaction,
    );
  });

  it("does not let an administrator change application membership", async () => {
    const service = new ApplicationMembersService(
      {
        application: {
          findFirst: vi
            .fn()
            .mockResolvedValue(
              application(
                ApplicationRole.ADMIN,
                defaultApplicationPermissions(ApplicationRole.ADMIN),
              ),
            ),
        },
      } as unknown as DatabaseClient,
      webAuth(),
      {} as AuditService,
    );

    await expect(
      service.create(request, "support", { email: "reader@example.test" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("keeps at least one owner", async () => {
    const transaction = {
      applicationMember: {
        findUnique: vi.fn().mockResolvedValue({
          userId: "owner-1",
          role: ApplicationRole.OWNER,
          permissions: defaultApplicationPermissions(ApplicationRole.OWNER),
          user: { name: "Owner", email: "owner@example.test" },
          createdAt: new Date(),
        }),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    const service = new ApplicationMembersService(
      {
        application: { findFirst: vi.fn().mockResolvedValue(application()) },
        $transaction: vi.fn().mockImplementation((callback) => callback(transaction)),
      } as unknown as DatabaseClient,
      webAuth(),
      {} as AuditService,
    );

    await expect(
      service.update(request, "support", "owner-1", { role: "admin" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

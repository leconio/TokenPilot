import { describe, expect, it, vi } from "vitest";

import type { DatabaseClient } from "@tokenpilot/db";

import type { AuditService } from "../../src/audit.service.js";
import { RuntimeAccessSnapshotService } from "../../src/runtime-configuration/runtime-access-snapshot.service.js";
import { signRuntimeSnapshot } from "../../src/runtime-configuration/runtime-snapshot-integrity.js";

const applicationId = "00000000-0000-4000-8000-000000000711";
const now = new Date("2026-07-18T12:00:00.000Z");

function currentSnapshot() {
  return signRuntimeSnapshot({
    schema_version: "2.0",
    application_id: applicationId,
    version: "runtime-support-3",
    expires_at: "2036-07-18T12:00:00.000Z",
    routing: {
      chat: {
        virtual_model_id: "00000000-0000-4000-8000-000000000712",
        configuration_version: 3,
        configuration_etag: `sha256:${"8".repeat(64)}`,
        published_at: "2026-07-18T11:00:00.000Z",
        timezone: "Asia/Shanghai",
        default: {
          route_tag: "cp:virtual:chat:default",
          selection_mode: "ordered",
          targets: [
            {
              model_id: "00000000-0000-4000-8000-000000000713",
              model_tag: "openai/gpt-4.1",
              route_tag: "cp:virtual:chat:default",
              fallback_order: 0,
              weight: 1,
            },
          ],
        },
        rules: [],
      },
    },
    aiu: { enabled: true, mode: "hard_limit", unrated_model_policy: "allow_unrated" },
    access: { application_enabled: true, blocked_user_ids: ["old-user"] },
    dimensions: { analytics_allowed_keys: ["member_level"] },
  });
}

function fixture(withCurrent = true) {
  const source = currentSnapshot();
  const findFirst = vi.fn().mockImplementation(({ where }) =>
    Promise.resolve(
      where.status === "PUBLISHED"
        ? withCurrent
          ? {
              applicationId,
              etag: source.etag,
              signature: source.signature,
              snapshotJson: source,
            }
          : null
        : { version: 3 },
    ),
  );
  const create = vi.fn().mockResolvedValue({ id: "00000000-0000-4000-8000-000000000714" });
  const database = {
    application: {
      findUnique: vi.fn().mockResolvedValue({ slug: "support", status: "DISABLED" }),
    },
    applicationUser: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ externalId: "blocked-a" }, { externalId: "blocked-b" }]),
    },
    runtimeConfigurationVersion: {
      findFirst,
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create,
    },
    virtualModel: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  } as unknown as DatabaseClient;
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return { source, database, audit, create, service: new RuntimeAccessSnapshotService(audit) };
}

describe("RuntimeAccessSnapshotService", () => {
  it("publishes current application and user access while preserving routing", async () => {
    const value = fixture();

    await expect(
      value.service.publishWithin(value.database, {
        applicationId,
        actorId: "user:owner-1",
        reason: "Paused application",
        now,
      }),
    ).resolves.toMatchObject({ version: 4 });

    const data = value.create.mock.calls[0]?.[0].data as {
      version: number;
      publishedBy: string;
      snapshotJson: ReturnType<typeof currentSnapshot>;
    };
    expect(data.version).toBe(4);
    expect(data.publishedBy).toBe("owner-1");
    expect(data.snapshotJson.access).toEqual({
      application_enabled: false,
      blocked_user_ids: ["blocked-a", "blocked-b"],
    });
    expect(data.snapshotJson.routing.chat?.configuration_version).toBe(4);
    expect(data.snapshotJson.routing.chat?.default).toEqual(value.source.routing.chat?.default);
    expect(data.snapshotJson.aiu).toEqual(value.source.aiu);
    expect(data.snapshotJson.dimensions).toEqual(value.source.dimensions);
    expect(data.snapshotJson.etag).not.toBe(value.source.etag);
    expect(value.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "runtime_configuration.access.publish",
        applicationId,
        actorId: "user:owner-1",
        reason: "Paused application",
      }),
      value.database,
    );
  });

  it("does not invent routing before the first manual publication", async () => {
    const value = fixture(false);
    await expect(
      value.service.publishWithin(value.database, {
        applicationId,
        actorId: "user:owner-1",
        reason: "Stopped user access",
      }),
    ).resolves.toBeNull();
    expect(value.create).not.toHaveBeenCalled();
  });
});

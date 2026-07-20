import { describe, expect, it, vi } from "vitest";

import { Prisma, type DatabaseClient } from "@tokenpilot/db";

import type { AuditContextService } from "../../src/audit-context.js";
import type { AuditService } from "../../src/audit.service.js";
import { RuntimeConfigurationRestoreService } from "../../src/runtime-configuration/runtime-configuration-restore.service.js";
import { RuntimeConfigurationService } from "../../src/runtime-configuration/runtime-configuration.service.js";

const applicationId = "00000000-0000-4000-8000-000000000611";
const virtualModelId = "00000000-0000-4000-8000-000000000612";
const primaryId = "00000000-0000-4000-8000-000000000613";
const fallbackId = "00000000-0000-4000-8000-000000000614";
const connectionId = "00000000-0000-4000-8000-000000000610";
const now = new Date("2026-07-20T00:00:00.000Z");

function connection() {
  return {
    id: connectionId,
    applicationId,
    name: "LiteLLM",
    driver: "LITELLM",
    baseUrl: "http://litellm.test/v1",
    credentialRef: "LITELLM_API_KEY",
    publicConfigJson: { timeout_ms: 60000, max_retries: 1 },
    enabled: true,
    status: "AVAILABLE",
  };
}

function model(id: string, name: string, tag: string) {
  return {
    id,
    applicationId,
    name,
    connectionId,
    requestModel: tag,
    provider: "openai",
    taskType: "CHAT",
    capabilitiesJson: [],
    notes: null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    connection: connection(),
  };
}

function virtualModel(
  matchJson: unknown = {
    schedule: { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" },
  },
) {
  const primary = model(primaryId, "主模型", "openai/gpt-4.1");
  const fallback = model(fallbackId, "备用模型", "openai/gpt-4.1-mini");
  return {
    id: virtualModelId,
    applicationId,
    name: "chat",
    displayName: "对话",
    taskType: "CHAT",
    enabled: true,
    defaultModelId: primaryId,
    description: null,
    lastPublishedVersion: null,
    createdAt: now,
    updatedAt: now,
    application: { timezone: "Asia/Shanghai" },
    defaultModel: primary,
    targets: [
      {
        id: "00000000-0000-4000-8000-000000000615",
        applicationId,
        virtualModelId,
        modelId: primaryId,
        priority: 0,
        weight: new Prisma.Decimal(1),
        enabled: true,
        createdAt: now,
        updatedAt: now,
        model: primary,
      },
      {
        id: "00000000-0000-4000-8000-000000000616",
        applicationId,
        virtualModelId,
        modelId: fallbackId,
        priority: 1,
        weight: new Prisma.Decimal(1),
        enabled: true,
        createdAt: now,
        updatedAt: now,
        model: fallback,
      },
    ],
    rules: [
      {
        id: "00000000-0000-4000-8000-000000000617",
        applicationId,
        virtualModelId,
        name: "高峰时段",
        priority: 1000,
        matchJson,
        targetModelId: fallbackId,
        expiresAt: null,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        targetModel: fallback,
      },
    ],
  };
}

function fixture(row = virtualModel()) {
  const create = vi
    .fn()
    .mockImplementation(({ data }) =>
      Promise.resolve({ id: "00000000-0000-4000-8000-000000000618", ...data }),
    );
  const transaction = {
    runtimeConfigurationVersion: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create,
    },
    virtualModel: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const database = {
    application: { findUnique: vi.fn().mockResolvedValue({ status: "ACTIVE" }) },
    applicationUser: { findMany: vi.fn().mockResolvedValue([]) },
    applicationUserGroup: { findMany: vi.fn().mockResolvedValue([]) },
    connectorInstance: { findMany: vi.fn().mockResolvedValue([]) },
    callConnection: { findMany: vi.fn().mockResolvedValue([connection()]) },
    applicationSettings: {
      findUnique: vi.fn().mockResolvedValue({ featureAiu: true, featureHardLimit: false }),
    },
    propertyDefinition: {
      findMany: vi.fn().mockResolvedValue([
        { key: "team", scope: "USER" },
        { key: "next_action", scope: "EVENT" },
      ]),
    },
    modelDefinition: { findMany: vi.fn().mockResolvedValue([]) },
    virtualModel: { findMany: vi.fn().mockResolvedValue([row]) },
    runtimeConfigurationAcknowledgement: { findMany: vi.fn().mockResolvedValue([]) },
    runtimeConfigurationVersion: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue({ version: 2 }),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    $transaction: vi.fn().mockImplementation((callback) => callback(transaction)),
  } as unknown as DatabaseClient;
  const context = {
    current: () => ({ applicationId, applicationSlug: "demo", actorId: "user:test" }),
  } as unknown as AuditContextService;
  const audit = { record: vi.fn() } as unknown as AuditService;
  return {
    database,
    create,
    service: new RuntimeConfigurationService(database, context, audit),
    restoreService: new RuntimeConfigurationRestoreService(database, context, audit),
  };
}

describe("RuntimeConfigurationService", () => {
  it("publishes one application-bound virtual-model snapshot with real LiteLLM order", async () => {
    const value = fixture();
    await expect(value.service.publish(now)).resolves.toMatchObject({
      version: 3,
      virtual_model_count: 1,
      etag: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    const data = value.create.mock.calls[0]?.[0].data as Record<string, unknown>;
    const snapshot = data.snapshotJson as {
      application_id: string;
      signature: string;
      routing: Record<
        string,
        {
          default: {
            selection_mode: string;
            targets: readonly { request_model: string; weight: number }[];
          };
          rules: readonly { route: { targets: readonly { request_model: string }[] } }[];
        }
      >;
      dimensions: {
        analytics_allowed_keys: readonly string[];
      };
      access: { application_enabled: boolean; blocked_user_ids: readonly string[] };
    };
    expect(data).toMatchObject({ applicationId, version: 3, status: "PUBLISHED" });
    expect(data.signature).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(snapshot.routing.chat?.default.targets.map((target) => target.request_model)).toEqual([
      "openai/gpt-4.1",
      "openai/gpt-4.1-mini",
    ]);
    expect(snapshot.routing.chat?.default.selection_mode).toBe("ordered");
    expect(snapshot.routing.chat?.default.targets.map((target) => target.weight)).toEqual([1, 1]);
    expect(
      snapshot.routing.chat?.rules[0]?.route.targets.map((target) => target.request_model),
    ).toEqual(["openai/gpt-4.1-mini", "openai/gpt-4.1"]);
    expect(snapshot.dimensions).toEqual({
      analytics_allowed_keys: ["team", "next_action"],
    });
    expect(snapshot.access).toEqual({ application_enabled: true, blocked_user_ids: [] });
    expect(snapshot.application_id).toBe(applicationId);
    expect(snapshot.signature).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(value.database.virtualModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { applicationId, enabled: true } }),
    );
  });

  it("publishes weighted default routing only when a candidate weight was changed", async () => {
    const row = virtualModel();
    row.targets[1]!.weight = new Prisma.Decimal(4);
    const value = fixture(row);
    await value.service.publish(now);
    const data = value.create.mock.calls[0]?.[0].data as Record<string, unknown>;
    const snapshot = data.snapshotJson as {
      routing: Record<string, { default: { selection_mode: string } }>;
    };
    expect(snapshot.routing.chat?.default.selection_mode).toBe("weighted");
  });

  it("rejects an invalid condition before retiring the current published configuration", async () => {
    const value = fixture(virtualModel({ arbitrary: true }));
    await expect(value.service.publish(now)).rejects.toMatchObject({ status: 400 });
    expect(value.database.$transaction).not.toHaveBeenCalled();
  });

  it("rejects ambiguous equal-priority conditions before retiring the active configuration", async () => {
    const row = virtualModel();
    row.rules.push({
      ...row.rules[0]!,
      id: "00000000-0000-4000-8000-000000000699",
      name: "另一个条件",
    });
    const value = fixture(row);
    await expect(value.service.publish(now)).rejects.toMatchObject({ status: 400 });
    expect(value.database.$transaction).not.toHaveBeenCalled();
  });

  it("returns every publication problem in one response", async () => {
    const row = virtualModel({ arbitrary: true });
    row.rules.push({
      ...row.rules[0]!,
      id: "00000000-0000-4000-8000-000000000698",
      name: "重复优先级",
    });
    const value = fixture(row);

    await expect(value.service.publish(now)).rejects.toMatchObject({
      status: 400,
      response: {
        code: "PUBLICATION_VALIDATION_FAILED",
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "ROUTE_CONDITION_INVALID" }),
          expect.objectContaining({ code: "ROUTE_PRIORITY_DUPLICATE" }),
        ]),
      },
    });
    expect(value.database.$transaction).not.toHaveBeenCalled();
  });

  it("publishes a saved user group as a fixed application-user snapshot", async () => {
    const groupId = "00000000-0000-4000-8000-000000000619";
    const value = fixture(virtualModel({ user_group: { group_id: groupId } }));
    value.database.applicationUserGroup.findMany = vi.fn().mockResolvedValue([
      {
        id: groupId,
        definitionVersion: 2,
        evaluations: [
          {
            definitionVersion: 2,
            members: [{ user: { externalId: "customer-42" } }],
          },
        ],
      },
    ]);

    await value.service.publish(now);

    const data = value.create.mock.calls[0]?.[0].data as Record<string, unknown>;
    const snapshot = data.snapshotJson as {
      routing: Record<string, { rules: readonly { match: unknown }[] }>;
    };
    expect(snapshot.routing.chat?.rules[0]?.match).toEqual({
      user: { ids: ["customer-42"] },
    });
  });

  it("includes blocked users in the local access policy", async () => {
    const value = fixture();
    value.database.applicationUser.findMany = vi.fn().mockResolvedValue([
      {
        externalId: "blocked-user",
        tags: [],
        status: "BLOCKED",
        quota: null,
      },
    ]);

    await value.service.publish(now);

    const data = value.create.mock.calls[0]?.[0].data as Record<string, unknown>;
    const snapshot = data.snapshotJson as {
      access: { application_enabled: boolean; blocked_user_ids: readonly string[] };
    };
    expect(snapshot.access).toEqual({
      application_enabled: true,
      blocked_user_ids: ["blocked-user"],
    });
  });

  it("restores historical routing as a new immutable version with current access controls", async () => {
    const value = fixture();
    await value.service.publish(now);
    const sourceData = value.create.mock.calls[0]?.[0].data as {
      etag: string;
      signature: string;
      snapshotJson: Record<string, unknown>;
    };
    value.database.runtimeConfigurationVersion.findUnique = vi.fn().mockResolvedValue({
      etag: sourceData.etag,
      signature: sourceData.signature,
      snapshotJson: sourceData.snapshotJson,
    });
    value.database.runtimeConfigurationVersion.findFirst = vi
      .fn()
      .mockResolvedValue({ version: 3 });
    value.database.modelDefinition.findMany = vi
      .fn()
      .mockResolvedValue([{ id: primaryId }, { id: fallbackId }]);
    value.database.applicationUser.findMany = vi
      .fn()
      .mockResolvedValue([
        { externalId: "blocked-after-first-release", tags: [], status: "BLOCKED", quota: null },
      ]);

    await expect(
      value.restoreService.restore(3, new Date(now.getTime() + 1_000)),
    ).resolves.toMatchObject({
      version: 4,
      restored_from_version: 3,
    });
    const restored = value.create.mock.calls[1]?.[0].data as {
      version: number;
      etag: string;
      signature: string;
      snapshotJson: {
        access: { blocked_user_ids: readonly string[] };
        routing: Record<string, { configuration_version: number }>;
      };
    };
    expect(restored.version).toBe(4);
    expect(restored.etag).not.toBe(sourceData.etag);
    expect(restored.signature).not.toBe(sourceData.signature);
    expect(restored.snapshotJson.routing.chat?.configuration_version).toBe(4);
    expect(restored.snapshotJson.access.blocked_user_ids).toEqual(["blocked-after-first-release"]);
    expect(
      (sourceData.snapshotJson.routing as Record<string, { configuration_version: number }>).chat,
    ).toMatchObject({ configuration_version: 3 });
  });

  it("rejects a historical configuration that no longer passes integrity checks", async () => {
    const value = fixture();
    value.database.runtimeConfigurationVersion.findUnique = vi.fn().mockResolvedValue({
      etag: `sha256:${"a".repeat(64)}`,
      signature: `sha256:${"b".repeat(64)}`,
      snapshotJson: { schema_version: "2.0", application_id: applicationId },
    });

    await expect(value.restoreService.restore(2, now)).rejects.toMatchObject({ status: 400 });
    expect(value.database.$transaction).not.toHaveBeenCalled();
  });

  it("reports applied only after every active LiteLLM instance confirms the current version", async () => {
    const value = fixture();
    value.database.runtimeConfigurationVersion.findMany = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000680",
        version: 3,
        status: "PUBLISHED",
        etag: `sha256:${"a".repeat(64)}`,
        publishedAt: now,
        publishedBy: "user-1",
        createdAt: now,
      },
    ]);
    value.database.connectorInstance.findMany = vi
      .fn()
      .mockResolvedValue([{ instanceId: "connector-a" }, { instanceId: "connector-b" }]);
    value.database.runtimeConfigurationAcknowledgement.findMany = vi.fn().mockResolvedValue([
      {
        configurationVersion: 3,
        connectorInstanceId: "connector-a",
        connectorName: "litellm",
        connectorVersion: "0.2.0",
        state: "APPLIED",
        acknowledgedAt: now,
        appliedAt: now,
        errorCode: null,
        errorMessage: null,
      },
    ]);

    await expect(value.service.list()).resolves.toMatchObject({
      versions: [
        {
          version: 3,
          effective_state: "pending",
          connectors: [
            { instance_id: "connector-a", state: "applied" },
            { instance_id: "connector-b", state: "pending" },
          ],
        },
      ],
    });

    value.database.runtimeConfigurationAcknowledgement.findMany = vi.fn().mockResolvedValue([
      {
        configurationVersion: 3,
        connectorInstanceId: "connector-a",
        connectorName: "litellm",
        connectorVersion: "0.2.0",
        state: "APPLIED",
        acknowledgedAt: now,
        appliedAt: now,
        errorCode: null,
        errorMessage: null,
      },
      {
        configurationVersion: 3,
        connectorInstanceId: "connector-b",
        connectorName: "litellm",
        connectorVersion: "0.2.0",
        state: "REJECTED",
        acknowledgedAt: now,
        appliedAt: null,
        errorCode: "INVALID_CONFIGURATION",
        errorMessage: "无法应用配置",
      },
    ]);
    await expect(value.service.list()).resolves.toMatchObject({
      versions: [
        {
          effective_state: "rejected",
          connectors: [
            {},
            {
              instance_id: "connector-b",
              error: { code: "INVALID_CONFIGURATION", message: "无法应用配置" },
            },
          ],
        },
      ],
    });
  });
});

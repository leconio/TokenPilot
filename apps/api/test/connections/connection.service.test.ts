import { describe, expect, it, vi } from "vitest";

import { CallConnectionDriver, CallConnectionStatus, type DatabaseClient } from "@tokenpilot/db";

import type { AuditContextService } from "../../src/audit-context.js";
import type { AuditService } from "../../src/audit.service.js";
import { ConnectionService } from "../../src/connections/connection.service.js";

const applicationId = "00000000-0000-4000-8000-000000000111";
const connectionId = "00000000-0000-4000-8000-000000000112";
const connectorId = "00000000-0000-4000-8000-000000000113";
const now = new Date("2026-07-20T12:00:00.000Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: connectionId,
    applicationId,
    name: "Primary service",
    driver: CallConnectionDriver.OPENAI_COMPATIBLE,
    baseUrl: "https://models.example.com/v1",
    credentialRef: "MODEL_API_KEY",
    publicConfigJson: { timeout_ms: 30000, max_retries: 1 },
    enabled: true,
    status: CallConnectionStatus.UNVERIFIED,
    connectorInstanceId: null,
    connectorInstance: null,
    lastSeenAt: null,
    _count: { models: 0 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fixture(overrides: Record<string, unknown> = {}) {
  let current = row(overrides);
  const database = {
    callConnection: {
      findMany: vi.fn().mockResolvedValue([current]),
      findFirst: vi.fn().mockImplementation(() => Promise.resolve(current)),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve(row(data))),
      update: vi.fn().mockImplementation(({ data }) => {
        current = row({ ...current, ...data });
        return Promise.resolve(current);
      }),
      delete: vi.fn().mockResolvedValue({}),
    },
    connectorInstance: {
      findFirst: vi.fn().mockResolvedValue({ id: connectorId }),
    },
  } as unknown as DatabaseClient;
  const context = {
    current: () => ({ applicationId, applicationSlug: "demo", actorId: "user:test" }),
  } as unknown as AuditContextService;
  const audit = { record: vi.fn() } as unknown as AuditService;
  return { database, service: new ConnectionService(database, context, audit), audit };
}

describe("ConnectionService", () => {
  it("lists only connections from the active application without exposing secrets", async () => {
    const value = fixture();
    await expect(value.service.list()).resolves.toMatchObject({
      connections: [
        {
          id: connectionId,
          driver: "openai_compatible",
          credential_ref: "MODEL_API_KEY",
          status: "unverified",
          model_count: 0,
        },
      ],
    });
    expect(value.database.callConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { applicationId } }),
    );
  });

  it("creates a connection with a local credential reference but rejects secret values", async () => {
    const value = fixture();
    await expect(
      value.service.create({
        name: "Primary service",
        driver: "openai_compatible",
        base_url: "https://models.example.com/v1",
        credential_ref: "MODEL_API_KEY",
      }),
    ).resolves.toMatchObject({ driver: "openai_compatible", credential_ref: "MODEL_API_KEY" });
    await expect(
      value.service.create({
        name: "Unsafe",
        driver: "openai_compatible",
        base_url: "https://models.example.com/v1",
        credential_ref: "MODEL_API_KEY",
        api_key: "must-not-enter-control-plane",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(value.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "connection.secret_rejected",
        after: { rejected_fields: ["api_key"] },
      }),
    );
  });

  it("binds a LiteLLM connector only when it belongs to the active application", async () => {
    const value = fixture();
    await value.service.create({
      name: "LiteLLM",
      driver: "litellm",
      base_url: "http://litellm.internal/v1",
      connector_instance_id: connectorId,
    });
    expect(value.database.connectorInstance.findFirst).toHaveBeenCalledWith({
      where: { id: connectorId, applicationId, type: "litellm" },
      select: { id: true },
    });
    value.database.connectorInstance.findFirst = vi.fn().mockResolvedValue(null);
    await expect(
      value.service.create({
        name: "Foreign LiteLLM",
        driver: "litellm",
        base_url: "http://litellm.internal/v1",
        connector_instance_id: connectorId,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("does not delete or change the type of a connection that still owns models", async () => {
    const value = fixture({ _count: { models: 2 } });
    await expect(value.service.delete(connectionId)).rejects.toMatchObject({ status: 409 });
    await expect(
      value.service.update(connectionId, { driver: "anthropic", base_url: null }),
    ).rejects.toMatchObject({ status: 409 });
    expect(value.database.callConnection.delete).not.toHaveBeenCalled();
  });

  it("reports LiteLLM bindings as unverified until a connector is selected", async () => {
    const value = fixture({
      driver: CallConnectionDriver.LITELLM,
      baseUrl: "http://litellm.internal/v1",
    });
    await expect(value.service.check(connectionId)).resolves.toEqual({
      valid: false,
      status: "unverified",
      message: "Bind a LiteLLM connector instance",
    });
  });
});

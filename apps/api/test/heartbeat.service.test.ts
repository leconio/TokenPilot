import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { connectorHeartbeatSchema, type ConnectorHeartbeat } from "@tokenpilot/contracts";
import type { DatabaseClient } from "@tokenpilot/db";

import type { AuditService } from "../src/audit.service.js";
import type { AuditContextService } from "../src/audit-context.js";
import { HeartbeatService } from "../src/heartbeat.service.js";

function heartbeat(overrides: Partial<ConnectorHeartbeat> = {}): ConnectorHeartbeat {
  const sentAt = new Date(Date.now() - 10_000);
  const lastUploadAt = new Date(sentAt.getTime() - 1_000);
  return connectorHeartbeatSchema.parse({
    schema_version: "2.0",
    heartbeat_id: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
    sent_at: sentAt.toISOString(),
    connector: {
      instance_id: "litellm-1",
      name: "tokenpilot-litellm",
      type: "litellm",
      version: "2.0.0",
    },
    capabilities: {
      usage_schema: "2.0",
      application_users: true,
      privacy_mode: "content_free",
      durable_batch_upload: true,
    },
    status: "healthy",
    buffer_depth: 7,
    oldest_event_age_seconds: 12.5,
    last_successful_upload_at: lastUploadAt.toISOString(),
    ...overrides,
  });
}

const applicationId = "00000000-0000-4000-8000-000000000921";
const otherApplicationId = "00000000-0000-4000-8000-000000000922";
const identity = (application: string, value: string) => `${application}:${value}`;
const contextFor = (application: string) =>
  ({
    current: () => ({ actorId: "service:key", applicationId: application, applicationSlug: "app" }),
  }) as unknown as AuditContextService;

function databaseFixture() {
  const connectors = new Map<string, Record<string, unknown>>();
  const receipts = new Map<string, { payloadHash: string }>();
  let sequence = 0;
  const connectorInstance = {
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const key = where.applicationId_instanceId as
        { applicationId: string; instanceId: string } | undefined;
      return key === undefined
        ? null
        : (connectors.get(identity(key.applicationId, key.instanceId)) ?? null);
    }),
    upsert: vi.fn(
      async ({
        where,
        create,
      }: {
        where: {
          applicationId_instanceId: { applicationId: string; instanceId: string };
        };
        create: Record<string, unknown>;
      }) => {
        const connectorIdentity = where.applicationId_instanceId;
        const key = identity(connectorIdentity.applicationId, connectorIdentity.instanceId);
        let row = connectors.get(key);
        if (row === undefined) {
          sequence += 1;
          const created = { id: `connector-${sequence}`, ...create } as Record<string, unknown>;
          connectors.set(key, created);
          row = created;
        }
        return { id: row.id };
      },
    ),
    updateMany: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = [...connectors.values()].find((candidate) => candidate.id === where.id);
        if (row === undefined) return { count: 0 };
        const currentSentAt = row.heartbeatSentAt as Date | null;
        const incomingSentAt = data.heartbeatSentAt as Date;
        const currentId = row.lastHeartbeatId as string | null;
        const incomingId = data.lastHeartbeatId as string;
        const newer =
          currentSentAt === null ||
          incomingSentAt > currentSentAt ||
          (incomingSentAt.getTime() === currentSentAt.getTime() &&
            (currentId === null || incomingId > currentId));
        if (newer) Object.assign(row, data);
        return { count: newer ? 1 : 0 };
      },
    ),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
      const row = [...connectors.values()].find((candidate) => candidate.id === where.id);
      if (row === undefined) throw new Error("missing connector");
      return { lastHeartbeatId: row.lastHeartbeatId };
    }),
  };
  const connectorHeartbeatReceipt = {
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const key = where.applicationId_heartbeatId as
        { applicationId: string; heartbeatId: string } | undefined;
      return key === undefined
        ? null
        : (receipts.get(identity(key.applicationId, key.heartbeatId)) ?? null);
    }),
    create: vi.fn(
      async ({
        data,
      }: {
        data: { applicationId: string; heartbeatId: string; payloadHash: string };
      }) => {
        receipts.set(identity(data.applicationId, data.heartbeatId), {
          payloadHash: data.payloadHash,
        });
        return { id: `receipt-${receipts.size}` };
      },
    ),
  };
  const transaction = { connectorInstance, connectorHeartbeatReceipt, auditLog: {} };
  const database = {
    connectorHeartbeatReceipt: { findUnique: connectorHeartbeatReceipt.findUnique },
    $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
      callback(transaction),
    ),
  } as unknown as DatabaseClient;
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const context = contextFor(applicationId);
  return { database, audit, context, connectors, receipts };
}

const capabilityHeaders = {
  "x-request-id": "01JZZZZZZZZZZZZZZZZZZZZZZZ",
  "x-tokenpilot-usage-schemas": "2.0",
  "x-tokenpilot-privacy-mode": "content-free",
};

describe("HeartbeatService", () => {
  it("persists capabilities, safe buffer state, receipt identity, and registration audit", async () => {
    const fixture = databaseFixture();
    const service = new HeartbeatService(fixture.database, fixture.audit, fixture.context);

    await expect(service.record(heartbeat(), capabilityHeaders)).resolves.toMatchObject({
      status: "accepted",
      heartbeat_id: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
      snapshot_updated: true,
    });
    expect(fixture.receipts).toHaveLength(1);
    expect(fixture.connectors.get(identity(applicationId, "litellm-1"))).toMatchObject({
      bufferDepth: 7,
      oldestEventAgeSeconds: 12.5,
      capabilitiesJson: {
        usage_schema: "2.0",
        application_users: true,
        privacy_mode: "content_free",
        durable_batch_upload: true,
      },
    });
    expect(fixture.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "connector.registered" }),
      expect.anything(),
    );
  });

  it("returns a duplicate for the same immutable heartbeat payload", async () => {
    const fixture = databaseFixture();
    const service = new HeartbeatService(fixture.database, fixture.audit, fixture.context);
    const input = heartbeat();

    await service.record(input, capabilityHeaders);
    await expect(service.record(structuredClone(input), capabilityHeaders)).resolves.toMatchObject({
      status: "duplicate",
      snapshot_updated: false,
    });
    expect(fixture.receipts).toHaveLength(1);
  });

  it("keeps the same connector and heartbeat IDs independent in two applications", async () => {
    const fixture = databaseFixture();
    const first = new HeartbeatService(fixture.database, fixture.audit, fixture.context);
    const second = new HeartbeatService(
      fixture.database,
      fixture.audit,
      contextFor(otherApplicationId),
    );

    await expect(first.record(heartbeat(), capabilityHeaders)).resolves.toMatchObject({
      status: "accepted",
    });
    await expect(second.record(heartbeat(), capabilityHeaders)).resolves.toMatchObject({
      status: "accepted",
    });

    expect(fixture.connectors).toHaveLength(2);
    expect(fixture.receipts).toHaveLength(2);
  });

  it("audits and rejects heartbeat ID reuse with different content", async () => {
    const fixture = databaseFixture();
    const service = new HeartbeatService(fixture.database, fixture.audit, fixture.context);
    await service.record(heartbeat(), capabilityHeaders);

    await expect(
      service.record(heartbeat({ status: "degraded" }), capabilityHeaders),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "connector.heartbeat.conflict" }),
    );
  });

  it("keeps the newest snapshot when a delayed heartbeat arrives", async () => {
    const fixture = databaseFixture();
    const service = new HeartbeatService(fixture.database, fixture.audit, fixture.context);
    const latestSentAt = new Date(Date.now() - 10_000);
    const delayedSentAt = new Date(latestSentAt.getTime() - 60_000);
    const newest = heartbeat({
      heartbeat_id: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
      sent_at: latestSentAt.toISOString(),
      buffer_depth: 9,
      oldest_event_age_seconds: 20,
    });
    const delayed = heartbeat({
      heartbeat_id: "01JYYYYYYYYYYYYYYYYYYYYYYY",
      sent_at: delayedSentAt.toISOString(),
      buffer_depth: 2,
      oldest_event_age_seconds: 5,
      last_successful_upload_at: new Date(delayedSentAt.getTime() - 1_000).toISOString(),
    });

    await service.record(newest);
    await expect(service.record(delayed)).resolves.toMatchObject({ snapshot_updated: false });
    expect(fixture.connectors.get(identity(applicationId, "litellm-1"))).toMatchObject({
      lastHeartbeatId: newest.heartbeat_id,
      bufferDepth: 9,
    });
  });

  it("rejects inconsistent durable-buffer state and capability headers", async () => {
    const fixture = databaseFixture();
    const service = new HeartbeatService(fixture.database, fixture.audit, fixture.context);

    await expect(
      service.record(heartbeat({ buffer_depth: 0, oldest_event_age_seconds: 1 })),
    ).rejects.toThrow("oldest_event_age_seconds");
    await expect(
      service.record(heartbeat(), {
        ...capabilityHeaders,
        "x-tokenpilot-privacy-mode": "full-content",
      }),
    ).rejects.toThrow("x-tokenpilot-privacy-mode");
  });
});

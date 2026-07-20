import { describe, expect, it, vi } from "vitest";

import type { DatabaseClient } from "@tokenpilot/db";

import type { AuditContextService } from "../../src/audit-context.js";
import { RuntimeConfigurationAcknowledgementService } from "../../src/runtime-configuration/runtime-acknowledgement.service.js";

const applicationId = "00000000-0000-4000-8000-000000000701";
const etag = `sha256:${"a".repeat(64)}`;
const acknowledgement = {
  schema_version: "2.0",
  application_id: applicationId,
  acknowledgement_id: "01J2QZ8V2H6Y0Y9W6Z42V97X3F",
  acknowledged_at: "2026-07-18T08:00:00.000Z",
  connector: { instance_id: "orders-api", name: "node", version: "0.2.0" },
  configuration_version: 7,
  configuration_etag: etag,
  state: "applied",
  applied_at: "2026-07-18T08:00:00.000Z",
  error: null,
} as const;

function fixture(options?: { existingHash?: string; configurationEtag?: string | null }) {
  const create = vi.fn().mockResolvedValue({ id: "ack-row" });
  const database = {
    runtimeConfigurationAcknowledgement: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          options?.existingHash === undefined ? null : { payloadHash: options.existingHash },
        ),
      findUniqueOrThrow: vi.fn(),
      create,
    },
    runtimeConfigurationVersion: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          options?.configurationEtag === null
            ? null
            : { etag: options?.configurationEtag ?? etag, status: "PUBLISHED" },
        ),
    },
  } as unknown as DatabaseClient;
  const context = {
    current: () => ({ applicationId, applicationSlug: "orders", actorId: "api-key:test" }),
  } as unknown as AuditContextService;
  return {
    create,
    service: new RuntimeConfigurationAcknowledgementService(database, context),
  };
}

describe("RuntimeConfigurationAcknowledgementService", () => {
  it("stores an acknowledgement under the authenticated application", async () => {
    const value = fixture();
    await expect(value.service.acknowledge(acknowledgement)).resolves.toEqual({
      status: "accepted",
      duplicate: false,
    });
    expect(value.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationId,
        configurationVersion: 7,
        configurationEtag: etag,
        connectorInstanceId: "orders-api",
        state: "APPLIED",
      }),
    });
  });

  it("rejects an ETag from another application or configuration", async () => {
    const value = fixture({ configurationEtag: `sha256:${"b".repeat(64)}` });
    await expect(value.service.acknowledge(acknowledgement)).rejects.toMatchObject({
      status: 404,
    });
    expect(value.create).not.toHaveBeenCalled();
    await expect(
      fixture().service.acknowledge({
        ...acknowledgement,
        application_id: "00000000-0000-4000-8000-000000000799",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("accepts an exact replay and rejects an acknowledgement ID conflict", async () => {
    const crypto = await import("node:crypto");
    const hash = crypto.createHash("sha256").update(JSON.stringify(acknowledgement)).digest("hex");
    await expect(
      fixture({ existingHash: hash }).service.acknowledge(acknowledgement),
    ).resolves.toEqual({ status: "accepted", duplicate: true });
    await expect(
      fixture({ existingHash: "0".repeat(64) }).service.acknowledge(acknowledgement),
    ).rejects.toMatchObject({ status: 409 });
  });
});

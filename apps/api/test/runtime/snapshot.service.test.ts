import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseClient } from "@tokenpilot/db";

import type { AuditContextService } from "../../src/audit-context.js";
import { signRuntimeSnapshot } from "../../src/runtime-configuration/runtime-snapshot-integrity.js";
import { RuntimeSnapshotService } from "../../src/runtime/snapshot.service.js";

const applicationId = "00000000-0000-4000-8000-000000000411";

function publishedSnapshot() {
  return signRuntimeSnapshot({
    schema_version: "2.0",
    application_id: applicationId,
    version: "runtime-demo-3",
    expires_at: "2036-07-16T12:00:00.000Z",
    routing: {
      "text.fast": {
        virtual_model_id: "00000000-0000-4000-8000-000000000412",
        configuration_version: 3,
        configuration_etag: `sha256:${"8".repeat(64)}`,
        published_at: "2026-07-16T12:00:00.000Z",
        timezone: "Asia/Shanghai",
        default: {
          route_tag: "cp:virtual:text.fast:default",
          selection_mode: "ordered",
          targets: [
            {
              model_id: "00000000-0000-4000-8000-000000000413",
              model_tag: "openai/gpt-4.1",
              provider: "openai",
              route_tag: "cp:virtual:text.fast:default",
              fallback_order: 0,
              weight: 1,
            },
          ],
        },
        rules: [],
      },
    },
    aiu: { enabled: true, mode: "observe", unrated_model_policy: "allow_unrated" },
    access: { application_enabled: true, blocked_user_ids: ["blocked-user"] },
    dimensions: { analytics_allowed_keys: ["team"] },
  });
}

function service(snapshot: unknown = publishedSnapshot()) {
  const value = snapshot as ReturnType<typeof publishedSnapshot>;
  const findFirst = vi.fn().mockResolvedValue({
    applicationId,
    etag: value.etag,
    signature: value.signature,
    snapshotJson: snapshot,
  });
  const database = {
    runtimeConfigurationVersion: { findFirst },
  } as unknown as DatabaseClient;
  const context = {
    current: () => ({ applicationId, applicationSlug: "demo", actorId: "service_key:test" }),
  } as unknown as AuditContextService;
  return { snapshots: new RuntimeSnapshotService(database, context), findFirst };
}

describe("RuntimeSnapshotService", () => {
  it("returns only the latest configuration for the authenticated application", async () => {
    const { snapshots, findFirst } = service();
    const first = await snapshots.get();
    const etag = first.snapshot.etag;

    expect(first).toMatchObject({ notModified: false, snapshot: { version: "runtime-demo-3" } });
    expect((await snapshots.get(`W/"${etag}"`)).notModified).toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: { applicationId, status: "PUBLISHED" },
      orderBy: { version: "desc" },
      select: { applicationId: true, etag: true, signature: true, snapshotJson: true },
    });
  });

  it("fails closed when the application has no published configuration", async () => {
    const value = service();
    value.findFirst.mockResolvedValue(null);
    await expect(value.snapshots.get()).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects a stored payload that is not a valid runtime configuration", async () => {
    const value = service({ schema_version: "2.0" });
    await expect(value.snapshots.get()).rejects.toThrow();
  });

  it("rejects a valid-looking snapshot whose immutable content or application binding changed", async () => {
    const snapshot = publishedSnapshot();
    const changed = {
      ...snapshot,
      access: { ...snapshot.access, blocked_user_ids: ["another-user"] },
    };
    await expect(service(changed).snapshots.get()).rejects.toMatchObject({ status: 503 });
    const { etag: _etag, signature: _signature, ...unsigned } = snapshot;
    void _etag;
    void _signature;
    const otherApplication = signRuntimeSnapshot({
      ...unsigned,
      application_id: "00000000-0000-4000-8000-000000000499",
    });
    await expect(service(otherApplication).snapshots.get()).rejects.toMatchObject({ status: 503 });
  });
});

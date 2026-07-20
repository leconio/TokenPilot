import { describe, expect, it, vi } from "vitest";

import type { DatabaseClient } from "@tokenpilot/db";

import { AuditContextService, normalizeAuditIp } from "../src/audit-context.js";
import { AuditService } from "../src/audit.service.js";

describe("audit request attribution", () => {
  it("persists the authenticated actor and normalized peer IP without leaking credentials", async () => {
    const create = vi.fn().mockResolvedValue({});
    const context = new AuditContextService();
    const audit = new AuditService({ auditLog: { create } } as unknown as DatabaseClient, context);

    await context.run("::ffff:127.0.0.1", async () => {
      context.setActor("service_key:0d24de67-1e21-4c88-aaf4-83a8c62cf38f");
      await audit.record({
        action: "test.write",
        objectType: "fixture",
        objectId: "fixture-1",
        reason: "operator approved",
      });
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "service_key:0d24de67-1e21-4c88-aaf4-83a8c62cf38f",
        ip: "127.0.0.1",
      }),
    });
    expect(JSON.stringify(create.mock.calls)).not.toContain("Bearer");
  });

  it("attributes non-request work to system and rejects non-IP forwarding text", async () => {
    const create = vi.fn().mockResolvedValue({});
    const audit = new AuditService({ auditLog: { create } } as unknown as DatabaseClient);

    await audit.record({ action: "system.write", objectType: "fixture", objectId: "fixture-2" });

    expect(create.mock.calls[0]?.[0].data.actorId).toBe("system");
    expect(normalizeAuditIp("203.0.113.8, 198.51.100.7")).toBeUndefined();
    expect(normalizeAuditIp("fe80::1%lo0")).toBe("fe80::1");
  });
});

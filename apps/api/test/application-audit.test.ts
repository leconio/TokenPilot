import { describe, expect, it, vi } from "vitest";

import type { DatabaseClient } from "@tokenpilot/db";

import type { ApiConfiguration } from "../src/api-config.js";
import type { AuditContextService } from "../src/audit-context.js";
import { WebDataService } from "../src/web-data.service.js";

describe("application audit", () => {
  it("binds every audit list to the authenticated application", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new WebDataService(
      { auditLog: { findMany } } as unknown as DatabaseClient,
      {} as ApiConfiguration,
      {
        current: () => ({
          actorId: "user:admin",
          applicationId: "00000000-0000-4000-8000-000000000901",
          applicationSlug: "app-a",
        }),
      } as unknown as AuditContextService,
    );

    await service.audit({ limit: "25" });

    expect(findMany).toHaveBeenCalledWith({
      where: { applicationId: "00000000-0000-4000-8000-000000000901" },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
  });

  it("binds connector health to the same application", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new WebDataService(
      { connectorInstance: { findMany } } as unknown as DatabaseClient,
      {} as ApiConfiguration,
      {
        current: () => ({
          actorId: "user:admin",
          applicationId: "00000000-0000-4000-8000-000000000901",
          applicationSlug: "app-a",
        }),
      } as unknown as AuditContextService,
    );

    await service.connectors();

    expect(findMany).toHaveBeenCalledWith({
      where: { applicationId: "00000000-0000-4000-8000-000000000901" },
      orderBy: { lastHeartbeatAt: "desc" },
    });
  });
});

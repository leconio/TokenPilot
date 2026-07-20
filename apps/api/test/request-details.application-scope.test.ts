import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseClient } from "@tokenpilot/db";

import type { AuditContextService } from "../src/audit-context.js";
import { RequestDetailsService } from "../src/request-details.service.js";

describe("request details application boundary", () => {
  it("always combines request_id with the application resolved from the credential", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new RequestDetailsService(
      { usageEventRegistry: { findMany } } as unknown as DatabaseClient,
      {
        current: () => ({ actorId: "service_key:key", applicationId: "application-a" }),
      } as AuditContextService,
    );

    await expect(service.find("shared-request")).rejects.toBeInstanceOf(NotFoundException);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { applicationId: "application-a", requestId: "shared-request" },
      }),
    );
  });

  it("fails closed when no application identity was established", async () => {
    const service = new RequestDetailsService(
      {} as DatabaseClient,
      {
        current: () => ({ actorId: "system" }),
      } as AuditContextService,
    );

    await expect(service.find("request")).rejects.toBeInstanceOf(ForbiddenException);
  });
});

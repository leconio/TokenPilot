import { describe, expect, it, vi } from "vitest";

import {
  ApplicationRole,
  defaultApplicationPermissions,
  type DatabaseClient,
} from "@tokenpilot/db";

import type { AuditService } from "../src/audit.service.js";
import { ApplicationService } from "../src/applications/application.service.js";
import type { RuntimeAccessSnapshotService } from "../src/runtime-configuration/runtime-access-snapshot.service.js";
import type { WebAuthService } from "../src/web-auth.service.js";

function service(
  role: ApplicationRole,
  permissions: readonly string[] = defaultApplicationPermissions(role),
) {
  const findFirst = vi.fn().mockResolvedValue({
    id: "00000000-0000-4000-8000-000000000911",
    name: "App A",
    slug: "app-a",
    status: "ACTIVE",
    timezone: "UTC",
    baseCurrency: "USD",
    members: [{ role, permissions }],
    settings: {
      featureUsagePipeline: true,
      featureModelCatalog: true,
      featureAiu: true,
      featureQuota: true,
      featureHardLimit: false,
      featureReconciliation: false,
    },
  });
  const database = { application: { findFirst } } as unknown as DatabaseClient;
  const webAuth = {
    authenticate: vi.fn().mockResolvedValue({ userId: "user-1" }),
  } as unknown as WebAuthService;
  return new ApplicationService(
    database,
    webAuth,
    {} as AuditService,
    {} as RuntimeAccessSnapshotService,
  );
}

describe("application capabilities", () => {
  it("returns the selected application's enabled capabilities", async () => {
    const result = await service(ApplicationRole.ADMIN).capabilities(
      { headers: {} } as never,
      "app-a",
    );

    expect(result.capabilities).toEqual(["usage", "model_catalog", "aiu", "quota"]);
    expect(result.permissions).toContain("admin:write");
  });

  it("does not expose write permissions to a viewer", async () => {
    const result = await service(ApplicationRole.VIEWER).capabilities(
      { headers: {} } as never,
      "app-a",
    );

    expect(result.permissions.some((scope) => scope.endsWith(":write"))).toBe(false);
    expect(result.permissions).toContain("reports:read");
  });

  it("fails closed when persisted permissions are missing", async () => {
    const result = await service(ApplicationRole.OWNER, []).capabilities(
      { headers: {} } as never,
      "app-a",
    );

    expect(result.permissions).toEqual([]);
  });

  it("never elevates stored permissions beyond the selected role", async () => {
    const result = await service(ApplicationRole.VIEWER, [
      "admin:write",
      "reports:read",
    ]).capabilities({ headers: {} } as never, "app-a");

    expect(result.permissions).toEqual(["reports:read"]);
  });
});

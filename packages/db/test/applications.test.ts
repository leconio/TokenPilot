import { describe, expect, it } from "vitest";

import { ApplicationRole } from "../src/generated/prisma/client.js";
import {
  applicationPermissionsForWrite,
  applicationSlugBase,
  defaultApplicationPermissions,
  effectiveApplicationPermissions,
} from "../src/applications.js";

describe("application slug", () => {
  it.each([
    ["My Product", "my-product"],
    ["  Demo---API  ", "demo-api"],
    ["Crème Voice", "creme-voice"],
    ["语音助手", "app"],
  ])("normalizes %s", (name, expected) => {
    expect(applicationSlugBase(name)).toBe(expected);
  });

  it("keeps slugs within the database limit", () => {
    expect(applicationSlugBase("a".repeat(200))).toHaveLength(96);
  });

  it("persists complete owner defaults and read-only viewer defaults", () => {
    expect(defaultApplicationPermissions(ApplicationRole.OWNER)).toContain("admin:write");
    expect(defaultApplicationPermissions(ApplicationRole.VIEWER)).toContain("reports:read");
    expect(defaultApplicationPermissions(ApplicationRole.VIEWER)).not.toContain("admin:write");
  });

  it("intersects stored, role, and platform permissions and fails closed on empty storage", () => {
    expect(
      effectiveApplicationPermissions(
        ApplicationRole.VIEWER,
        ["reports:read", "admin:write"],
        ["admin:write", "reports:read"],
      ),
    ).toEqual(["reports:read"]);
    expect(effectiveApplicationPermissions(ApplicationRole.OWNER, [])).toEqual([]);
  });

  it("rejects permissions that exceed the selected role", () => {
    expect(() => applicationPermissionsForWrite(ApplicationRole.VIEWER, ["admin:write"])).toThrow(
      "exceed the selected role",
    );
  });
});

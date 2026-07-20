import { describe, expect, it, vi } from "vitest";

import type { DatabaseClient } from "@tokenpilot/db";

import type { AuditContextService } from "../../src/audit-context.js";
import type { AuditService } from "../../src/audit.service.js";
import { PropertyService } from "../../src/properties/property.service.js";

const applicationId = "00000000-0000-4000-8000-000000000311";
const now = new Date("2026-07-17T12:00:00.000Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000312",
    applicationId,
    key: "next_action",
    displayName: "Next action",
    scope: "EVENT",
    dataType: "TEXT",
    allowedValuesJson: null,
    searchable: true,
    groupable: false,
    sensitive: false,
    constraintsJson: {},
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fixture() {
  const database = {
    propertyDefinition: {
      findMany: vi.fn().mockResolvedValue([row()]),
      findFirst: vi.fn().mockResolvedValue(row()),
      create: vi.fn().mockImplementation(({ data }) => row(data)),
      update: vi.fn().mockImplementation(({ data }) => row(data)),
    },
  } as unknown as DatabaseClient;
  const context = {
    current: () => ({ actorId: "user:test", applicationId, applicationSlug: "test" }),
  } as unknown as AuditContextService;
  const audit = { record: vi.fn() } as unknown as AuditService;
  return { database, service: new PropertyService(database, context, audit) };
}

describe("PropertyService", () => {
  it("always lists fields inside the authenticated application", async () => {
    const value = fixture();
    await expect(value.service.list()).resolves.toMatchObject({
      properties: [{ key: "next_action", scope: "EVENT" }],
    });
    expect(value.database.propertyDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { applicationId } }),
    );
  });

  it("creates a typed application field", async () => {
    const value = fixture();
    await value.service.create({
      key: "intent",
      display_name: "Intent",
      scope: "USER",
      data_type: "ENUM",
      allowed_values: ["buy", "learn"],
    });
    expect(value.database.propertyDefinition.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationId,
        key: "intent",
        scope: "USER",
        dataType: "ENUM",
        allowedValuesJson: ["buy", "learn"],
      }),
    });
  });

  it("rejects built-in keys and enum fields without choices", async () => {
    const value = fixture();
    for (const key of ["user_id", "request_model", "input_tokens", "quota_status"]) {
      await expect(
        value.service.create({
          key,
          display_name: "Built in",
          scope: "USER",
          data_type: "TEXT",
        }),
      ).rejects.toMatchObject({ status: 400 });
    }
    await expect(
      value.service.create({
        key: "intent",
        display_name: "Intent",
        scope: "USER",
        data_type: "ENUM",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("does not update a field returned outside the application", async () => {
    const value = fixture();
    value.database.propertyDefinition.findFirst = vi.fn().mockResolvedValue(null);
    await expect(
      value.service.update("another-field", { status: "DISABLED" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(value.database.propertyDefinition.findFirst).toHaveBeenCalledWith({
      where: { id: "another-field", applicationId },
    });
  });

  it("turns off search and grouping when a field becomes sensitive", async () => {
    const value = fixture();
    await value.service.update("field", { sensitive: true });

    expect(value.database.propertyDefinition.update).toHaveBeenCalledWith({
      where: { id: row().id },
      data: expect.objectContaining({ sensitive: true, searchable: false, groupable: false }),
    });
  });
});

import { describe, expect, it, vi } from "vitest";

import { SavedReportKind, type DatabaseClient } from "@tokenpilot/db";

import type { AuditContextService } from "../../src/audit-context.js";
import type { AuditService } from "../../src/audit.service.js";
import { SavedReportService } from "../../src/reports/saved-report.service.js";

const applicationId = "00000000-0000-4000-8000-000000000801";
const reportId = "00000000-0000-4000-8000-000000000802";
const cardId = "00000000-0000-4000-8000-000000000803";
const now = new Date("2026-07-18T04:00:00.000Z");
const definition = {
  version: 1 as const,
  range: "7d" as const,
  metric: "aiu" as const,
  filter_match: "all" as const,
  conditions: [
    {
      kind: "property" as const,
      scope: "user" as const,
      key: "plan",
      operator: "equals" as const,
      values: ["pro"],
    },
  ],
  group: { kind: "property" as const, scope: "user" as const, key: "plan" },
  grain: "day" as const,
};

function reportRow() {
  return {
    id: reportId,
    applicationId,
    name: "付费用户 AIU",
    kind: SavedReportKind.AIU,
    definitionJson: definition,
    createdBy: "user:owner",
    createdAt: now,
    updatedAt: now,
  };
}

function fixture() {
  const database = {
    savedReport: {
      findMany: vi.fn().mockResolvedValue([reportRow()]),
      findFirst: vi.fn().mockResolvedValue(reportRow()),
      create: vi.fn().mockImplementation(({ data }) => ({ ...reportRow(), ...data })),
      update: vi.fn().mockImplementation(({ data }) => ({ ...reportRow(), ...data })),
    },
    propertyDefinition: {
      findMany: vi.fn().mockResolvedValue([
        {
          key: "plan",
          scope: "USER",
          searchable: true,
          groupable: true,
          sensitive: false,
          dataType: "ENUM",
        },
      ]),
    },
    applicationDashboardCard: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: cardId, applicationId, reportId, position: 0, width: 1 }),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(({ data }) => ({
        id: cardId,
        ...data,
        report: reportRow(),
        createdAt: now,
        updatedAt: now,
      })),
      update: vi.fn().mockImplementation(({ data }) => ({
        id: cardId,
        applicationId,
        reportId,
        position: 0,
        width: 1,
        ...data,
        report: reportRow(),
        createdAt: now,
        updatedAt: now,
      })),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  } as unknown as DatabaseClient;
  const context = {
    current: () => ({ actorId: "user:owner", applicationId, applicationSlug: "demo" }),
  } as unknown as AuditContextService;
  const audit = { record: vi.fn() } as unknown as AuditService;
  return { database, service: new SavedReportService(database, context, audit) };
}

describe("SavedReportService", () => {
  it("lists only reports from the authenticated application", async () => {
    const value = fixture();
    await expect(value.service.list()).resolves.toMatchObject({
      reports: [
        {
          id: reportId,
          kind: "aiu",
          definition,
          required_permission: "reports:read",
          created_by: "user:owner",
          updated_at: now.toISOString(),
        },
      ],
    });
    expect(value.database.savedReport.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { applicationId } }),
    );
  });

  it("saves a typed report definition with the application and actor", async () => {
    const value = fixture();
    await value.service.create({ name: "付费用户 AIU", kind: "aiu", definition });
    expect(value.database.savedReport.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationId,
        kind: SavedReportKind.AIU,
        createdBy: "user:owner",
        definitionJson: definition,
      }),
    });
  });

  it("rejects a metric that does not belong to the report type", async () => {
    const value = fixture();
    await expect(
      value.service.create({
        name: "错误指标",
        kind: "aiu",
        definition: { ...definition, metric: "provider_cost" },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(value.database.savedReport.create).not.toHaveBeenCalled();
  });

  it("does not persist a saved report containing a sensitive field value", async () => {
    const value = fixture();
    value.database.propertyDefinition.findMany = vi.fn().mockResolvedValue([
      {
        key: "plan",
        scope: "USER",
        searchable: true,
        groupable: true,
        sensitive: true,
        dataType: "ENUM",
      },
    ]);

    await expect(
      value.service.create({ name: "敏感字段", kind: "aiu", definition }),
    ).rejects.toMatchObject({ status: 400 });
    expect(value.database.savedReport.create).not.toHaveBeenCalled();
  });

  it("does not return a legacy report after one of its fields becomes sensitive", async () => {
    const value = fixture();
    value.database.propertyDefinition.findMany = vi.fn().mockResolvedValue([
      {
        key: "plan",
        scope: "USER",
        searchable: true,
        groupable: true,
        sensitive: true,
        dataType: "ENUM",
      },
    ]);

    await expect(value.service.list()).resolves.toEqual({ reports: [] });
  });

  it("rejects a dashboard report from another application", async () => {
    const value = fixture();
    value.database.savedReport.findFirst = vi.fn().mockResolvedValue(null);
    await expect(value.service.addDashboard({ report_id: reportId })).rejects.toMatchObject({
      status: 404,
    });
    expect(value.database.savedReport.findFirst).toHaveBeenCalledWith({
      where: { id: reportId, applicationId },
    });
    expect(value.database.applicationDashboardCard.create).not.toHaveBeenCalled();
  });

  it("adds a saved report to the current application's dashboard", async () => {
    const value = fixture();
    await expect(
      value.service.addDashboard({ report_id: reportId, width: 2 }),
    ).resolves.toMatchObject({
      id: cardId,
      width: 2,
      report: { id: reportId },
    });
    expect(value.database.applicationDashboardCard.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ applicationId, reportId, width: 2 }),
      }),
    );
  });
});

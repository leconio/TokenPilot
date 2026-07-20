import { describe, expect, it, vi } from "vitest";

import { Prisma, type DatabaseClient } from "@tokenpilot/db";

import type { AuditContextService } from "../../src/audit-context.js";
import type { AuditService } from "../../src/audit.service.js";
import { ModelService } from "../../src/models/model.service.js";

const applicationId = "00000000-0000-4000-8000-000000000211";
const now = new Date("2026-07-17T12:00:00.000Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000212",
    applicationId,
    name: "Main chat",
    litellmTag: "openai/gpt-4.1",
    provider: "openai",
    capabilitiesJson: [],
    notes: null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fixture() {
  const database = {
    modelDefinition: {
      findMany: vi.fn().mockResolvedValue([row()]),
      findFirst: vi.fn().mockResolvedValue({
        ...row(),
        application: { baseCurrency: "USD" },
      }),
      create: vi.fn().mockImplementation(({ data }) => row(data)),
      update: vi.fn().mockImplementation(({ data }) => row(data)),
    },
    applicationUsageRating: {
      aggregate: vi.fn().mockResolvedValue({
        _count: { _all: 3 },
        _sum: {
          totalTokens: new Prisma.Decimal(1_250),
          providerCost: new Prisma.Decimal("0.125"),
          aiuMicros: 2_500_000n,
        },
      }),
      findMany: vi.fn().mockResolvedValue([
        {
          eventId: "00000000-0000-4000-8000-000000000215",
          ratedAt: now,
          costStatus: "unpriced",
          aiuStatus: "unrated",
        },
      ]),
    },
    usageEventRegistry: {
      findMany: vi.fn().mockResolvedValue([
        {
          eventId: "00000000-0000-4000-8000-000000000216",
          eventTime: new Date("2026-07-17T11:00:00.000Z"),
          lastError: "Model not resolved",
        },
      ]),
    },
    virtualModel: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "00000000-0000-4000-8000-000000000214",
          name: "assistant",
          displayName: "Assistant",
          enabled: true,
          defaultModelId: row().id,
          targets: [{ id: "target-1" }],
          rules: [],
        },
      ]),
    },
  } as unknown as DatabaseClient;
  const context = {
    current: () => ({ actorId: "user:test", applicationId, applicationSlug: "test" }),
  } as unknown as AuditContextService;
  const audit = { record: vi.fn() } as unknown as AuditService;
  return { database, context, audit, service: new ModelService(database, context, audit) };
}

describe("ModelService", () => {
  it("always lists models inside the authenticated application", async () => {
    const value = fixture();
    await expect(value.service.list()).resolves.toMatchObject({
      models: [{ name: "Main chat", litellm_tag: "openai/gpt-4.1" }],
    });
    expect(value.database.modelDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { applicationId } }),
    );
  });

  it("creates a model with only a name and LiteLLM tag", async () => {
    const value = fixture();
    await expect(
      value.service.create({ name: "Main chat", litellm_tag: "openai/gpt-4.1" }),
    ).resolves.toMatchObject({ provider: "openai", enabled: true });
    expect(value.database.modelDefinition.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationId,
        name: "Main chat",
        litellmTag: "openai/gpt-4.1",
        provider: "openai",
      }),
    });
  });

  it("rejects cross-application lookup results", async () => {
    const value = fixture();
    value.database.modelDefinition.findFirst = vi.fn().mockResolvedValue(null);
    await expect(value.service.get("another-model")).rejects.toMatchObject({ status: 404 });
    expect(value.database.modelDefinition.findFirst).toHaveBeenCalledWith({
      where: { id: "another-model", applicationId },
      include: { application: { select: { baseCurrency: true } } },
    });
  });

  it("returns application-scoped usage, routing references, and recent rating problems", async () => {
    const value = fixture();
    await expect(value.service.get(row().id)).resolves.toMatchObject({
      metrics: {
        calls: 3,
        tokens: "1250",
        cost: "0.125",
        currency: "USD",
        aiu: "2.5",
        aiu_micros: "2500000",
      },
      virtual_model_references: [
        expect.objectContaining({ name: "assistant", uses_as: ["default", "candidate"] }),
      ],
      recent_issues: [
        expect.objectContaining({ types: ["unpriced", "unrated"] }),
        expect.objectContaining({ types: ["unresolved"] }),
      ],
    });
    expect(value.database.applicationUsageRating.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { applicationId, modelId: row().id } }),
    );
    expect(value.database.usageEventRegistry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { applicationId, modelTag: "openai/gpt-4.1", realModelId: null },
      }),
    );
    expect(value.database.virtualModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ applicationId }) }),
    );
  });

  it("previews only this application's virtual-model impact before disabling", async () => {
    const value = fixture();
    await expect(value.service.disableImpact(row().id)).resolves.toMatchObject({
      reference_count: 1,
      affects_routing: true,
      virtual_models: [{ name: "assistant" }],
    });
    expect(value.database.virtualModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ applicationId }) }),
    );
  });
});

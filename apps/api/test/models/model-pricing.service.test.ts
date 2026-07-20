import { describe, expect, it, vi } from "vitest";

import { usageTypeValues } from "@tokenpilot/contracts";
import { Prisma, type DatabaseClient } from "@tokenpilot/db";

import type { AuditContextService } from "../../src/audit-context.js";
import type { AuditService } from "../../src/audit.service.js";
import { aiuUsage, costUsage } from "../../src/models/model-pricing.catalog.js";
import { ModelPricingService } from "../../src/models/model-pricing.service.js";

const applicationId = "00000000-0000-4000-8000-000000000711";
const modelId = "00000000-0000-4000-8000-000000000712";
const now = new Date("2026-07-20T00:00:00.000Z");

function fixture() {
  let cost: Record<string, unknown> | null = null;
  let aiu: Record<string, unknown> | null = null;
  const costCreate = vi.fn().mockImplementation(({ data }) => {
    cost = {
      id: "00000000-0000-4000-8000-000000000713",
      ...data,
      status: "PUBLISHED",
      publishedAt: now,
      createdAt: now,
      items: data.items.create.map((item: Record<string, unknown>, index: number) => ({
        id: `cost-${index}`,
        unitKey: "",
        ...item,
        unitSize: new Prisma.Decimal(String(item.unitSize)),
        unitPrice: new Prisma.Decimal(String(item.unitPrice)),
        createdAt: now,
      })),
    };
    return Promise.resolve(cost);
  });
  const aiuCreate = vi.fn().mockImplementation(({ data }) => {
    aiu = {
      id: "00000000-0000-4000-8000-000000000714",
      ...data,
      status: "PUBLISHED",
      publishedAt: now,
      createdAt: now,
      items: data.items.create.map((item: Record<string, unknown>, index: number) => ({
        id: `aiu-${index}`,
        unitKey: "",
        ...item,
        unitSize: new Prisma.Decimal(String(item.unitSize)),
        createdAt: now,
      })),
    };
    return Promise.resolve(aiu);
  });
  const transaction = {
    modelCostVersion: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), create: costCreate },
    modelAiuVersion: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), create: aiuCreate },
  };
  const database = {
    modelDefinition: {
      findFirst: vi.fn().mockResolvedValue({
        id: modelId,
        name: "主模型",
        litellmTag: "openai/gpt-4.1",
        application: { baseCurrency: "CNY" },
      }),
    },
    modelCostVersion: {
      findFirst: vi
        .fn()
        .mockImplementation(({ select }) =>
          Promise.resolve(select ? (cost === null ? null : { version: cost.version }) : cost),
        ),
    },
    modelAiuVersion: {
      findFirst: vi
        .fn()
        .mockImplementation(({ select }) =>
          Promise.resolve(select ? (aiu === null ? null : { version: aiu.version }) : aiu),
        ),
    },
    $transaction: vi.fn().mockImplementation((callback) => callback(transaction)),
  } as unknown as DatabaseClient;
  const context = {
    current: () => ({ applicationId, applicationSlug: "demo", actorId: "user:test" }),
  } as unknown as AuditContextService;
  const audit = { record: vi.fn() } as unknown as AuditService;
  return {
    database,
    costCreate,
    aiuCreate,
    service: new ModelPricingService(database, context, audit),
  };
}

describe("ModelPricingService", () => {
  it("covers every current contract usage type, with request excluded only from AIU", () => {
    const costTypes = new Set([...costUsage.map((item) => item.usageType), "custom_unit"]);
    const aiuTypes = new Set([...aiuUsage.map((item) => item.usageType), "custom_unit", "request"]);
    expect(costTypes).toEqual(new Set(usageTypeValues));
    expect(aiuTypes).toEqual(new Set(usageTypeValues));
    expect(aiuUsage.some((item) => item.usageType === "request")).toBe(false);
  });

  it("publishes model cost in the application currency with explicit units", async () => {
    const value = fixture();
    const result = await value.service.saveCost(
      modelId,
      { request: "0.002", input_per_million: "2.5", output_per_million: "10" },
      now,
    );
    expect(result).toMatchObject({
      cost: {
        version: 1,
        currency: "CNY",
        rates: { request: "0.002", input_per_million: "2.5", output_per_million: "10" },
      },
      aiu: null,
    });
    expect(value.costCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationId,
        modelId,
        currency: "CNY",
        items: {
          create: [
            expect.objectContaining({ usageType: "request", unitSize: "1", unitPrice: "0.002" }),
            expect.objectContaining({
              usageType: "uncached_input_token",
              unitSize: "1000000",
              unitPrice: "2.5",
            }),
            expect.objectContaining({
              usageType: "output_token",
              unitSize: "1000000",
              unitPrice: "10",
            }),
          ],
        },
      }),
      include: { items: true },
    });
    expect(value.costCreate.mock.calls[0]?.[0].data.items.create).toEqual(
      expect.arrayContaining([expect.not.objectContaining({ applicationId: expect.anything() })]),
    );
  });

  it("stores AIU as integer micro-units without floating point settlement", async () => {
    const value = fixture();
    const result = await value.service.saveAiu(
      modelId,
      {
        input_per_million: "0.125001",
        cache_read_per_million: "1.25",
        custom_units: [{ unit_key: "tool_call", unit_size: "10", rate: "0.000001" }],
      },
      now,
    );
    expect(result).toMatchObject({
      cost: null,
      aiu: {
        rates: {
          input_per_million: "0.125001",
          cache_read_per_million: "1.25",
          custom_units: [{ unit_key: "tool_call", unit_size: "10", rate: "0.000001" }],
        },
      },
    });
    expect(value.aiuCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationId,
        modelId,
        items: {
          create: [
            expect.objectContaining({
              usageType: "uncached_input_token",
              aiuMicrosPerUnit: 125_001n,
            }),
            expect.objectContaining({
              usageType: "cache_read_input_token",
              aiuMicrosPerUnit: 1_250_000n,
            }),
            expect.objectContaining({
              usageType: "custom_unit",
              unitKey: "tool_call",
              unitSize: "10",
              aiuMicrosPerUnit: 1n,
            }),
          ],
        },
      }),
      include: { items: true },
    });
    expect(value.aiuCreate.mock.calls[0]?.[0].data.items.create).toEqual(
      expect.arrayContaining([expect.not.objectContaining({ applicationId: expect.anything() })]),
    );
  });

  it("publishes multimodal, embedding, and typed custom-unit rates", async () => {
    const value = fixture();
    const result = await value.service.saveCost(
      modelId,
      {
        input_image: "0.01",
        output_audio_second: "0.0025",
        embedding_per_million: "0.125",
        custom_units: [
          { unit_key: "gpu_millisecond", unit_size: "1000", rate: "0.04" },
          { unit_key: "tool_call", unit_size: "1", rate: "0.005" },
        ],
      },
      now,
    );

    expect(result).toMatchObject({
      cost: {
        rates: {
          input_image: "0.01",
          output_audio_second: "0.0025",
          embedding_per_million: "0.125",
          custom_units: [
            { unit_key: "gpu_millisecond", unit_size: "1000", rate: "0.04" },
            { unit_key: "tool_call", unit_size: "1", rate: "0.005" },
          ],
        },
      },
    });
    expect(value.costCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          items: {
            create: expect.arrayContaining([
              expect.objectContaining({ usageType: "input_image", unitSize: "1" }),
              expect.objectContaining({ usageType: "output_audio_second", unitSize: "1" }),
              expect.objectContaining({ usageType: "embedding_token", unitSize: "1000000" }),
              expect.objectContaining({
                usageType: "custom_unit",
                unitKey: "gpu_millisecond",
                unitSize: "1000",
              }),
            ]),
          },
        }),
      }),
    );
  });

  it("strictly rejects duplicate or malformed custom-unit rates", async () => {
    const value = fixture();
    await expect(
      value.service.saveAiu(modelId, {
        custom_units: [
          { unit_key: "tool_call", unit_size: "1", rate: "1" },
          { unit_key: "tool_call", unit_size: "2", rate: "2" },
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      value.service.saveCost(modelId, {
        custom_units: [{ unit_key: "Tool Call", unit_size: "0", rate: "1" }],
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(value.costCreate).not.toHaveBeenCalled();
    expect(value.aiuCreate).not.toHaveBeenCalled();
  });

  it("rejects a model outside the authenticated application", async () => {
    const value = fixture();
    value.database.modelDefinition.findFirst = vi.fn().mockResolvedValue(null);
    await expect(value.service.get(modelId, now)).rejects.toMatchObject({ status: 404 });
    expect(value.database.modelDefinition.findFirst).toHaveBeenCalledWith({
      where: { id: modelId, applicationId },
      select: expect.any(Object),
    });
  });
});

import { describe, expect, it, vi } from "vitest";

import { usageTypeValues } from "@tokenpilot/contracts";
import { Prisma, type DatabaseClient } from "@tokenpilot/db";

import type { AuditContextService } from "../../src/audit-context.js";
import type { AuditService } from "../../src/audit.service.js";
import { aiuUsage } from "../../src/models/model-pricing.catalog.js";
import { ModelPricingService } from "../../src/models/model-pricing.service.js";

const applicationId = "00000000-0000-4000-8000-000000000711";
const modelId = "00000000-0000-4000-8000-000000000712";
const now = new Date("2026-07-20T00:00:00.000Z");

interface CostRuleCreate {
  readonly name: string;
  readonly priority: number;
  readonly matchMode: string;
  readonly conditionsJson: unknown;
  readonly fixedAmount: string | null;
  readonly items: { readonly create: readonly Record<string, unknown>[] };
}

interface CostVersionCreate {
  readonly rules: { readonly create: readonly CostRuleCreate[] };
  readonly [key: string]: unknown;
}

function fixture() {
  let cost: Record<string, unknown> | null = null;
  let aiu: Record<string, unknown> | null = null;
  const costCreate = vi.fn().mockImplementation(({ data }: { data: CostVersionCreate }) => {
    cost = {
      id: "00000000-0000-4000-8000-000000000713",
      ...data,
      status: "PUBLISHED",
      publishedAt: now,
      createdAt: now,
      rules: data.rules.create.map((rule, ruleIndex) => ({
        id: `00000000-0000-4000-8000-00000000072${ruleIndex}`,
        ...rule,
        fixedAmount:
          rule.fixedAmount === null ? null : new Prisma.Decimal(String(rule.fixedAmount)),
        conditionsJson: rule.conditionsJson,
        createdAt: now,
        items: rule.items.create.map((item: Record<string, unknown>, itemIndex: number) => ({
          id: `cost-${ruleIndex}-${itemIndex}`,
          unitKey: "",
          ...item,
          amountPerUnit: new Prisma.Decimal(String(item.amountPerUnit)),
          createdAt: now,
        })),
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
  const propertyFindMany = vi.fn().mockResolvedValue([]);
  const database = {
    modelDefinition: {
      findFirst: vi.fn().mockResolvedValue({
        id: modelId,
        name: "主模型",
        requestModel: "openai/gpt-4.1",
        application: { baseCurrency: "CNY" },
      }),
    },
    propertyDefinition: { findMany: propertyFindMany },
    modelCostVersion: {
      findFirst: vi
        .fn()
        .mockImplementation(({ select }) =>
          Promise.resolve(
            select
              ? cost === null
                ? null
                : { version: (cost as { readonly version: unknown }).version }
              : cost,
          ),
        ),
    },
    modelAiuVersion: {
      findFirst: vi
        .fn()
        .mockImplementation(({ select }) =>
          Promise.resolve(
            select
              ? aiu === null
                ? null
                : { version: (aiu as { readonly version: unknown }).version }
              : aiu,
          ),
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
    propertyFindMany,
    costCreate,
    aiuCreate,
    audit,
    service: new ModelPricingService(database, context, audit),
  };
}

describe("ModelPricingService", () => {
  it("keeps AIU coverage independent from model cost rules", () => {
    const aiuTypes = new Set([...aiuUsage.map((item) => item.usageType), "custom_unit", "request"]);
    expect(aiuTypes).toEqual(new Set(usageTypeValues));
    expect(aiuUsage.some((item) => item.usageType === "request")).toBe(false);
  });

  it("publishes ordered conditional cost rules in the application currency", async () => {
    const value = fixture();
    const result = await value.service.saveCostRules(
      modelId,
      {
        rules: [
          {
            name: "语音生产流量",
            match: "all",
            conditions: [
              { kind: "builtin", field: "provider", operator: "equals", values: ["openai"] },
            ],
            fixed_amount: "0.002",
            rates: [
              { usage_type: "uncached_input_token", amount_per_unit: "0.0000025" },
              { usage_type: "output_token", amount_per_unit: "0.00001" },
              {
                usage_type: "custom_unit",
                unit_key: "voice_second",
                amount_per_unit: "0.005",
              },
            ],
          },
        ],
      },
      now,
    );

    expect(result).toMatchObject({
      cost_currency: "CNY",
      cost: {
        version: 1,
        currency: "CNY",
        source_priority: "reported_first",
        rules: [
          {
            name: "语音生产流量",
            priority: 0,
            fixed_amount: "0.002",
            rates: [
              { usage_type: "uncached_input_token", amount_per_unit: "0.0000025" },
              { usage_type: "output_token", amount_per_unit: "0.00001" },
              {
                usage_type: "custom_unit",
                unit_key: "voice_second",
                amount_per_unit: "0.005",
              },
            ],
          },
        ],
      },
      aiu: null,
    });
    expect(value.costCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationId,
        modelId,
        currency: "CNY",
        rules: {
          create: [
            expect.objectContaining({
              name: "语音生产流量",
              priority: 0,
              matchMode: "all",
              fixedAmount: "0.002",
              items: {
                create: expect.arrayContaining([
                  expect.objectContaining({
                    usageType: "uncached_input_token",
                    amountPerUnit: "0.0000025",
                  }),
                  expect.objectContaining({
                    usageType: "custom_unit",
                    unitKey: "voice_second",
                  }),
                ]),
              },
            }),
          ],
        },
      }),
      include: { rules: { include: { items: true } } },
    });
  });

  it("validates custom fields against active non-sensitive property definitions", async () => {
    const value = fixture();
    value.propertyFindMany.mockResolvedValue([
      { key: "tier", scope: "USER", dataType: "ENUM", sensitive: false },
    ]);
    await expect(
      value.service.saveCostRules(modelId, {
        rules: [
          {
            name: "企业用户",
            match: "all",
            conditions: [
              {
                kind: "property",
                scope: "user",
                key: "tier",
                operator: "equals",
                values: ["enterprise"],
              },
            ],
            fixed_amount: "1",
            rates: [],
          },
        ],
      }),
    ).resolves.toMatchObject({ cost: { rules: [expect.objectContaining({ name: "企业用户" })] } });

    const rejected = fixture();
    rejected.propertyFindMany.mockResolvedValue([
      { key: "secret", scope: "USER", dataType: "TEXT", sensitive: true },
    ]);
    await expect(
      rejected.service.saveCostRules(modelId, {
        rules: [
          {
            name: "敏感字段",
            match: "all",
            conditions: [
              {
                kind: "property",
                scope: "user",
                key: "secret",
                operator: "equals",
                values: ["x"],
              },
            ],
            fixed_amount: "1",
            rates: [],
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("allows an empty fallback list so only reported costs are accepted", async () => {
    const value = fixture();
    await expect(value.service.saveCostRules(modelId, { rules: [] }, now)).resolves.toMatchObject({
      cost: { source_priority: "reported_first", rules: [] },
    });
  });

  it("stores AIU as integer micro-units without changing its existing contract", async () => {
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
  });

  it("strictly rejects malformed or duplicate cost amounts and AIU custom units", async () => {
    const value = fixture();
    await expect(
      value.service.saveCostRules(modelId, {
        rules: [
          {
            name: "重复用量",
            match: "all",
            conditions: [],
            rates: [
              { usage_type: "output_token", amount_per_unit: "1" },
              { usage_type: "output_token", amount_per_unit: "2" },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      value.service.saveAiu(modelId, {
        custom_units: [
          { unit_key: "tool_call", unit_size: "1", rate: "1" },
          { unit_key: "tool_call", unit_size: "2", rate: "2" },
        ],
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

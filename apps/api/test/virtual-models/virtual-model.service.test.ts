import { describe, expect, it, vi } from "vitest";

import { Prisma, type DatabaseClient } from "@tokenpilot/db";

import type { AuditContextService } from "../../src/audit-context.js";
import type { AuditService } from "../../src/audit.service.js";
import { VirtualModelService } from "../../src/virtual-models/virtual-model.service.js";

const applicationId = "00000000-0000-4000-8000-000000000511";
const virtualModelId = "00000000-0000-4000-8000-000000000512";
const primaryId = "00000000-0000-4000-8000-000000000513";
const peakId = "00000000-0000-4000-8000-000000000514";
const now = new Date("2026-07-17T12:00:00.000Z");

function model(id: string, name: string, tag: string) {
  return {
    id,
    applicationId,
    name,
    requestModel: tag,
    provider: "openai",
    taskType: "CHAT",
    capabilitiesJson: [],
    notes: null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function virtualModel() {
  const primary = model(primaryId, "常规模型", "openai/gpt-4.1-mini");
  const peak = model(peakId, "高峰模型", "openai/gpt-4.1");
  return {
    id: virtualModelId,
    applicationId,
    name: "chat",
    displayName: "对话",
    taskType: "CHAT",
    enabled: true,
    defaultModelId: primaryId,
    description: null,
    lastPublishedVersion: null,
    createdAt: now,
    updatedAt: now,
    application: { timezone: "Asia/Shanghai" },
    defaultModel: primary,
    targets: [
      {
        id: "00000000-0000-4000-8000-000000000515",
        applicationId,
        virtualModelId,
        modelId: primaryId,
        priority: 0,
        weight: new Prisma.Decimal(1),
        enabled: true,
        createdAt: now,
        updatedAt: now,
        model: primary,
      },
      {
        id: "00000000-0000-4000-8000-000000000516",
        applicationId,
        virtualModelId,
        modelId: peakId,
        priority: 1,
        weight: new Prisma.Decimal(1),
        enabled: true,
        createdAt: now,
        updatedAt: now,
        model: peak,
      },
    ],
    rules: [
      {
        id: "00000000-0000-4000-8000-000000000517",
        applicationId,
        virtualModelId,
        name: "工作日高峰",
        priority: 1000,
        matchJson: { schedule: { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" } },
        targetModelId: peakId,
        expiresAt: null,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        targetModel: peak,
      },
      {
        id: "00000000-0000-4000-8000-000000000518",
        applicationId,
        virtualModelId,
        name: "已过期临时切换",
        priority: 10000,
        matchJson: { override_active: true },
        targetModelId: peakId,
        expiresAt: new Date("2026-07-19T00:00:00.000Z"),
        enabled: true,
        createdAt: now,
        updatedAt: now,
        targetModel: peak,
      },
    ],
  };
}

function fixture() {
  let row = virtualModel();
  const database = {
    applicationUser: { findMany: vi.fn().mockResolvedValue([]) },
    applicationUserGroup: { findMany: vi.fn().mockResolvedValue([]) },
    virtualModel: {
      findFirst: vi.fn().mockImplementation(() => Promise.resolve(row)),
      update: vi.fn().mockImplementation(({ data }) => {
        row = { ...row, ...data };
        return Promise.resolve(row);
      }),
      delete: vi.fn().mockResolvedValue({}),
    },
    virtualModelTarget: {
      update: vi.fn().mockImplementation(({ where, data }) => {
        row = {
          ...row,
          targets: row.targets.map((target) =>
            target.id === where.id
              ? { ...target, weight: new Prisma.Decimal(data.weight) }
              : target,
          ),
        };
        return Promise.resolve({});
      }),
      delete: vi.fn().mockResolvedValue({}),
    },
    virtualModelRule: {
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    modelDefinition: {
      findFirst: vi.fn().mockResolvedValue({ id: primaryId }),
    },
    $transaction: vi.fn().mockImplementation((operations) => Promise.all(operations)),
  } as unknown as DatabaseClient;
  const context = {
    current: () => ({ applicationId, applicationSlug: "demo", actorId: "user:test" }),
  } as unknown as AuditContextService;
  const audit = { record: vi.fn() } as unknown as AuditService;
  return { database, service: new VirtualModelService(database, context, audit) };
}

describe("VirtualModelService", () => {
  it("selects the peak rule inside the application timezone and returns fallback order", async () => {
    const value = fixture();
    const result = await value.service.simulate(virtualModelId, {
      instant: "2026-07-20T02:00:00.000Z",
    });
    expect(result).toMatchObject({
      matched_rule: "工作日高峰",
      reason: "condition",
      model: { id: peakId, request_model: "openai/gpt-4.1" },
      fallbacks: ["openai/gpt-4.1-mini"],
    });
  });

  it("uses the default model outside peak time and ignores expired temporary rules", async () => {
    const value = fixture();
    await expect(
      value.service.simulate(virtualModelId, { instant: "2026-07-20T12:00:00.000Z" }),
    ).resolves.toMatchObject({
      matched_rule: null,
      reason: "default",
      selection_mode: "ordered",
      model: { id: primaryId },
      fallbacks: ["openai/gpt-4.1"],
    });
  });

  it("uses the published deterministic weight rule when a user is supplied", async () => {
    const value = fixture();
    await value.service.updateTarget(virtualModelId, "00000000-0000-4000-8000-000000000516", {
      weight: 1000,
    });
    await expect(
      value.service.simulate(virtualModelId, {
        instant: "2026-07-20T12:00:00.000Z",
        user_id: "weighted-user",
      }),
    ).resolves.toMatchObject({
      matched_rule: null,
      reason: "default",
      selection_mode: "weighted",
      model: { id: peakId },
      fallbacks: ["openai/gpt-4.1-mini"],
    });
  });

  it("rejects incomplete fallback orders rather than partially reordering", async () => {
    const value = fixture();
    await expect(
      value.service.reorderTargets(virtualModelId, {
        ordered_target_ids: ["00000000-0000-4000-8000-000000000515"],
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(value.database.virtualModelTarget.update).not.toHaveBeenCalled();
  });

  it("rejects a rule target that is not a candidate of this virtual model", async () => {
    const value = fixture();
    await expect(
      value.service.addRule(virtualModelId, {
        name: "跨模型规则",
        target_model_id: "00000000-0000-4000-8000-000000000599",
        match: { schedule: { days: [1], from: "09:00", to: "18:00" } },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(value.database.virtualModelRule.create).not.toHaveBeenCalled();
  });

  it("updates a candidate weight inside the current virtual model", async () => {
    const value = fixture();
    await expect(
      value.service.updateTarget(virtualModelId, "00000000-0000-4000-8000-000000000516", {
        weight: 4,
      }),
    ).resolves.toMatchObject({
      targets: [expect.anything(), expect.objectContaining({ weight: "4" })],
    });
  });

  it("binds every virtual-model lookup to the authenticated application", async () => {
    const value = fixture();
    await value.service.simulate(virtualModelId, { instant: "2026-07-20T02:00:00.000Z" });
    expect(value.database.virtualModel.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: virtualModelId, applicationId } }),
    );
  });

  it("moves the default before removing its route target", async () => {
    const value = fixture();
    await value.service.removeTarget(virtualModelId, "00000000-0000-4000-8000-000000000515");
    expect(value.database.virtualModelTarget.delete).toHaveBeenCalledWith({
      where: { id: "00000000-0000-4000-8000-000000000515" },
    });
    expect(value.database.virtualModel.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ defaultModelId: peakId }) }),
    );
  });

  it("deletes only the application-owned virtual model", async () => {
    const value = fixture();
    await expect(value.service.delete(virtualModelId)).resolves.toEqual({ deleted: true });
    expect(value.database.virtualModel.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: virtualModelId, applicationId } }),
    );
    expect(value.database.virtualModel.delete).toHaveBeenCalledWith({
      where: { id: virtualModelId },
    });
  });
});

import type { Prisma } from "@tokenpilot/db";

export const virtualModelRoutes = {
  application: { select: { timezone: true } },
  defaultModel: { select: { id: true, name: true, requestModel: true, taskType: true } },
  targets: {
    include: {
      model: {
        select: { id: true, name: true, requestModel: true, taskType: true, enabled: true },
      },
    },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  },
  rules: {
    include: {
      targetModel: {
        select: { id: true, name: true, requestModel: true, taskType: true, enabled: true },
      },
    },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  },
} satisfies Prisma.VirtualModelInclude;

export type VirtualModelRow = Prisma.VirtualModelGetPayload<{
  include: typeof virtualModelRoutes;
}>;

export function presentVirtualModel(row: VirtualModelRow) {
  return {
    id: row.id,
    name: row.name,
    display_name: row.displayName,
    task_type: row.taskType.toLowerCase(),
    enabled: row.enabled,
    description: row.description,
    default_model: row.defaultModel
      ? {
          id: row.defaultModel.id,
          name: row.defaultModel.name,
          request_model: row.defaultModel.requestModel,
          task_type: row.defaultModel.taskType.toLowerCase(),
        }
      : null,
    targets: row.targets.map((target) => ({
      id: target.id,
      model: {
        id: target.model.id,
        name: target.model.name,
        request_model: target.model.requestModel,
        task_type: target.model.taskType.toLowerCase(),
        enabled: target.model.enabled,
      },
      priority: target.priority,
      weight: target.weight.toString(),
      enabled: target.enabled,
    })),
    rules: row.rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      priority: rule.priority,
      match: rule.matchJson,
      target_model: {
        id: rule.targetModel.id,
        name: rule.targetModel.name,
        request_model: rule.targetModel.requestModel,
        task_type: rule.targetModel.taskType.toLowerCase(),
        enabled: rule.targetModel.enabled,
      },
      expires_at: rule.expiresAt?.toISOString() ?? null,
      enabled: rule.enabled,
    })),
    last_published_version: row.lastPublishedVersion,
    updated_at: row.updatedAt.toISOString(),
  };
}

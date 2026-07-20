import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { ModelTaskType, type DatabaseClient, type Prisma } from "@tokenpilot/db";
import { virtualModelRouteMatchSchema } from "@tokenpilot/contracts";

import { AuditContextService } from "../audit-context.js";
import { AuditService } from "../audit.service.js";
import { DATABASE_CLIENT } from "../tokens.js";
import {
  createVirtualModelSchema,
  createVirtualModelTargetSchema,
  createVirtualModelRuleSchema,
  reorderVirtualModelTargetsSchema,
  simulateVirtualModelSchema,
  updateVirtualModelTargetSchema,
  updateVirtualModelSchema,
  updateVirtualModelRuleSchema,
} from "./virtual-model.schemas.js";
import { loadRouteAudience, resolveRuntimeMatch, runtimeMatchApplies } from "./route-matches.js";
import { orderSimulationTargets } from "./weighted-route-selection.js";
import {
  presentVirtualModel,
  virtualModelRoutes,
  type VirtualModelRow,
} from "./virtual-model.presenter.js";

const taskTypeToDatabase = {
  chat: ModelTaskType.CHAT,
  embedding: ModelTaskType.EMBEDDING,
  image: ModelTaskType.IMAGE,
  audio: ModelTaskType.AUDIO,
} as const;

@Injectable()
export class VirtualModelService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(AuditContextService) private readonly context: AuditContextService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private applicationId(): string {
    const id = this.context.current().applicationId;
    if (id === undefined) throw new ForbiddenException("An application context is required");
    return id;
  }

  async list() {
    const rows = await this.database.virtualModel.findMany({
      where: { applicationId: this.applicationId() },
      include: virtualModelRoutes,
      orderBy: { name: "asc" },
    });
    return { virtual_models: rows.map((row) => presentVirtualModel(row)) };
  }

  async get(id: string) {
    return presentVirtualModel(await this.requireVirtualModel(id));
  }

  async create(input: unknown) {
    const parsed = createVirtualModelSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid virtual model");
    const value = parsed.data;
    if (value.default_model_id !== undefined && value.default_model_id !== null) {
      await this.assertModel(value.default_model_id, value.task_type);
    }
    const row = await this.database.virtualModel.create({
      data: {
        applicationId: this.applicationId(),
        name: value.name,
        displayName: value.display_name ?? value.name,
        taskType: taskTypeToDatabase[value.task_type],
        defaultModelId: value.default_model_id ?? null,
      },
      include: virtualModelRoutes,
    });
    await this.audit.record({
      action: "virtual_model.create",
      objectType: "virtual_model",
      objectId: row.id,
      after: { name: row.name },
      reason: "Created virtual model",
    });
    return presentVirtualModel(row);
  }

  async update(id: string, input: unknown) {
    const parsed = updateVirtualModelSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid virtual model changes");
    const current = await this.requireVirtualModel(id);
    if (parsed.data.enabled === true && current.targets.length === 0) {
      throw new BadRequestException("A virtual model needs at least one route before enabling");
    }
    const nextTaskType = parsed.data.task_type ?? current.taskType.toLowerCase();
    if (
      parsed.data.task_type !== undefined &&
      current.targets.some((target) => target.model.taskType.toLowerCase() !== nextTaskType)
    ) {
      throw new BadRequestException("Remove models with a different task type before changing it");
    }
    if (parsed.data.default_model_id !== undefined && parsed.data.default_model_id !== null) {
      await this.assertModel(parsed.data.default_model_id, nextTaskType);
    }
    const value = parsed.data;
    const row = await this.database.virtualModel.update({
      where: { id: current.id },
      data: {
        ...(value.display_name === undefined ? {} : { displayName: value.display_name }),
        ...(value.description === undefined ? {} : { description: value.description }),
        ...(value.task_type === undefined ? {} : { taskType: taskTypeToDatabase[value.task_type] }),
        ...(value.default_model_id === undefined ? {} : { defaultModelId: value.default_model_id }),
        ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
      },
      include: virtualModelRoutes,
    });
    return presentVirtualModel(row);
  }

  async addTarget(id: string, input: unknown) {
    const parsed = createVirtualModelTargetSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid route target");
    const virtualModel = await this.requireVirtualModel(id);
    const model = await this.assertModel(parsed.data.model_id, virtualModel.taskType.toLowerCase());
    const value = parsed.data;
    const target = await this.database.virtualModelTarget.create({
      data: {
        applicationId: this.applicationId(),
        virtualModelId: virtualModel.id,
        modelId: model.id,
        priority: value.priority ?? virtualModel.targets.length,
        weight: value.weight ?? 1,
      },
    });
    if (virtualModel.defaultModelId === null) {
      await this.database.virtualModel.update({
        where: { id: virtualModel.id },
        data: { defaultModelId: model.id },
      });
    }
    await this.audit.record({
      action: "virtual_model.route.add",
      objectType: "virtual_model",
      objectId: virtualModel.id,
      after: { target_id: target.id, model_id: model.id },
      reason: "Added route target",
    });
    return this.requireVirtualModel(id).then(presentVirtualModel);
  }

  async reorderTargets(id: string, input: unknown) {
    const parsed = reorderVirtualModelTargetsSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid fallback order");
    const virtualModel = await this.requireVirtualModel(id);
    const existing = new Set(virtualModel.targets.map((target) => target.id));
    if (
      parsed.data.ordered_target_ids.length !== existing.size ||
      parsed.data.ordered_target_ids.some((targetId) => !existing.has(targetId))
    ) {
      throw new BadRequestException("Fallback order must contain every candidate exactly once");
    }
    await this.database.$transaction(
      parsed.data.ordered_target_ids.map((targetId, priority) =>
        this.database.virtualModelTarget.update({ where: { id: targetId }, data: { priority } }),
      ),
    );
    return this.requireVirtualModel(id).then(presentVirtualModel);
  }

  async updateTarget(id: string, targetId: string, input: unknown) {
    const parsed = updateVirtualModelTargetSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid route weight");
    const virtualModel = await this.requireVirtualModel(id);
    const target = virtualModel.targets.find((candidate) => candidate.id === targetId);
    if (target === undefined) throw new NotFoundException("Route target not found");
    await this.database.virtualModelTarget.update({
      where: { id: target.id },
      data: { weight: parsed.data.weight },
    });
    await this.audit.record({
      action: "virtual_model.route.weight.update",
      objectType: "virtual_model",
      objectId: virtualModel.id,
      before: { target_id: target.id, weight: target.weight.toString() },
      after: { target_id: target.id, weight: parsed.data.weight },
      reason: "Updated weighted routing",
    });
    return this.requireVirtualModel(id).then(presentVirtualModel);
  }

  async removeTarget(id: string, targetId: string) {
    const virtualModel = await this.requireVirtualModel(id);
    const target = virtualModel.targets.find((candidate) => candidate.id === targetId);
    if (target === undefined) throw new NotFoundException("Route target not found");
    const nextDefault = virtualModel.targets.find((candidate) => candidate.id !== target.id);
    await this.database.$transaction([
      this.database.virtualModelTarget.delete({ where: { id: target.id } }),
      ...(virtualModel.defaultModelId === target.modelId
        ? [
            this.database.virtualModel.update({
              where: { id: virtualModel.id },
              data: {
                defaultModelId: nextDefault?.modelId ?? null,
                ...(nextDefault === undefined ? { enabled: false } : {}),
              },
            }),
          ]
        : []),
    ]);
    await this.audit.record({
      action: "virtual_model.route.delete",
      objectType: "virtual_model",
      objectId: virtualModel.id,
      before: { target_id: target.id, model_id: target.modelId },
      reason: "Removed route target",
    });
    return this.requireVirtualModel(id).then(presentVirtualModel);
  }

  async addRule(id: string, input: unknown) {
    const parsed = createVirtualModelRuleSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid route condition");
    const virtualModel = await this.requireVirtualModel(id);
    this.assertCandidate(virtualModel, parsed.data.target_model_id);
    const value = parsed.data;
    await this.database.virtualModelRule.create({
      data: {
        applicationId: this.applicationId(),
        virtualModelId: virtualModel.id,
        name: value.name,
        priority: value.priority ?? 1_000 - virtualModel.rules.length,
        matchJson: JSON.parse(JSON.stringify(value.match)) as Prisma.InputJsonValue,
        targetModelId: value.target_model_id,
        expiresAt: value.expires_at ? new Date(value.expires_at) : null,
      },
    });
    return this.requireVirtualModel(id).then(presentVirtualModel);
  }

  async updateRule(id: string, ruleId: string, input: unknown) {
    const parsed = updateVirtualModelRuleSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid route condition changes");
    const virtualModel = await this.requireVirtualModel(id);
    const current = virtualModel.rules.find((rule) => rule.id === ruleId);
    if (current === undefined) throw new NotFoundException("Route condition not found");
    const value = parsed.data;
    if (value.target_model_id !== undefined)
      this.assertCandidate(virtualModel, value.target_model_id);
    const nextMatch = value.match ?? virtualModelRouteMatchSchema.parse(current.matchJson);
    const nextExpiry =
      value.expires_at === undefined
        ? current.expiresAt
        : value.expires_at === null
          ? null
          : new Date(value.expires_at);
    if ("override_active" in nextMatch && nextExpiry === null) {
      throw new BadRequestException("A temporary route requires an expiry");
    }
    await this.database.virtualModelRule.update({
      where: { id: current.id },
      data: {
        ...(value.name === undefined ? {} : { name: value.name }),
        ...(value.target_model_id === undefined ? {} : { targetModelId: value.target_model_id }),
        ...(value.priority === undefined ? {} : { priority: value.priority }),
        ...(value.match === undefined
          ? {}
          : { matchJson: JSON.parse(JSON.stringify(value.match)) as Prisma.InputJsonValue }),
        ...(value.expires_at === undefined ? {} : { expiresAt: nextExpiry }),
        ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
      },
    });
    return this.requireVirtualModel(id).then(presentVirtualModel);
  }

  async removeRule(id: string, ruleId: string) {
    const virtualModel = await this.requireVirtualModel(id);
    const current = virtualModel.rules.find((rule) => rule.id === ruleId);
    if (current === undefined) throw new NotFoundException("Route condition not found");
    await this.database.virtualModelRule.delete({ where: { id: current.id } });
    return this.requireVirtualModel(id).then(presentVirtualModel);
  }

  async delete(id: string) {
    const current = await this.requireVirtualModel(id);
    await this.database.virtualModel.delete({ where: { id: current.id } });
    await this.audit.record({
      action: "virtual_model.delete",
      objectType: "virtual_model",
      objectId: current.id,
      before: { name: current.name, display_name: current.displayName },
      reason: "Deleted virtual model",
    });
    return { deleted: true };
  }

  async simulate(id: string, input: unknown) {
    const parsed = simulateVirtualModelSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid simulation time");
    const virtualModel = await this.requireVirtualModel(id);
    const instant = new Date(parsed.data.instant);
    const audience = await loadRouteAudience(this.database, this.applicationId());
    const routeContext = {
      userId: parsed.data.user_id,
      userProperties: parsed.data.user_properties,
      callSource: parsed.data.call_source,
    };
    const activeRules = virtualModel.rules
      .filter((rule) => rule.enabled && (rule.expiresAt === null || rule.expiresAt > instant))
      .filter((rule) => {
        try {
          return runtimeMatchApplies(
            resolveRuntimeMatch(rule.matchJson, audience),
            instant,
            virtualModel.application.timezone,
            routeContext,
          );
        } catch {
          return false;
        }
      });
    const selectedRule = activeRules[0] ?? null;
    const modelId = selectedRule?.targetModelId ?? virtualModel.defaultModelId;
    const fallbackOrder = [
      ...virtualModel.targets.filter((target) => target.modelId === modelId),
      ...virtualModel.targets.filter((target) => target.modelId !== modelId),
    ];
    if (fallbackOrder.length === 0) {
      throw new BadRequestException("The virtual model has no candidates");
    }
    const selection =
      selectedRule === null
        ? orderSimulationTargets(
            fallbackOrder,
            `cp:virtual:${virtualModel.name}:default`,
            parsed.data.user_id,
          )
        : { mode: "ordered" as const, targets: fallbackOrder };
    const [selected, ...fallbacks] = selection.targets;
    return {
      instant: instant.toISOString(),
      timezone: virtualModel.application.timezone,
      matched_rule: selectedRule?.name ?? null,
      reason: selectedRule === null ? "default" : "condition",
      selection_mode: selection.mode,
      model: {
        id: selected!.model.id,
        name: selected!.model.name,
        request_model: selected!.model.requestModel,
      },
      fallbacks: fallbacks.map((target) => target.model.requestModel),
    };
  }

  private async requireVirtualModel(id: string) {
    const row = await this.database.virtualModel.findFirst({
      where: { id, applicationId: this.applicationId() },
      include: virtualModelRoutes,
    });
    if (row === null) throw new NotFoundException("Virtual model not found");
    return row;
  }

  private assertCandidate(row: VirtualModelRow, modelId: string): void {
    if (!row.targets.some((target) => target.modelId === modelId && target.enabled)) {
      throw new BadRequestException("A route condition must select an enabled candidate");
    }
  }

  private async assertModel(id: string, taskType: string) {
    const row = await this.database.modelDefinition.findFirst({
      where: {
        id,
        applicationId: this.applicationId(),
        enabled: true,
        connection: { enabled: true },
      },
      select: { id: true, taskType: true },
    });
    if (row === null) throw new BadRequestException("Route model is not available");
    if (row.taskType.toLowerCase() !== taskType) {
      throw new BadRequestException("Route model uses a different task type");
    }
    return row;
  }
}

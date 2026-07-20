import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { ModelTaskType, Prisma, type DatabaseClient } from "@tokenpilot/db";

import { AuditContextService } from "../audit-context.js";
import { AuditService } from "../audit.service.js";
import { DATABASE_CLIENT } from "../tokens.js";
import {
  presentModelIssues,
  presentModelMetrics,
  presentModelReferences,
} from "./model-details.js";
import { createModelSchema, listModelsSchema, updateModelSchema } from "./model.schemas.js";

const taskTypeToDatabase = {
  chat: ModelTaskType.CHAT,
  embedding: ModelTaskType.EMBEDDING,
  image: ModelTaskType.IMAGE,
  audio: ModelTaskType.AUDIO,
} as const;

const taskTypeFromDatabase = {
  [ModelTaskType.CHAT]: "chat",
  [ModelTaskType.EMBEDDING]: "embedding",
  [ModelTaskType.IMAGE]: "image",
  [ModelTaskType.AUDIO]: "audio",
} as const;

const connectionSelect = {
  id: true,
  name: true,
  driver: true,
  enabled: true,
  status: true,
} as const;

function present(row: {
  readonly id: string;
  readonly name: string;
  readonly requestModel: string;
  readonly provider: string;
  readonly taskType: ModelTaskType;
  readonly capabilitiesJson: unknown;
  readonly notes: string | null;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly connection: {
    readonly id: string;
    readonly name: string;
    readonly driver: string;
    readonly enabled: boolean;
    readonly status: string;
  };
}) {
  return {
    id: row.id,
    name: row.name,
    request_model: row.requestModel,
    provider: row.provider,
    task_type: taskTypeFromDatabase[row.taskType],
    capabilities: row.capabilitiesJson,
    connection: {
      id: row.connection.id,
      name: row.connection.name,
      driver: row.connection.driver.toLowerCase(),
      enabled: row.connection.enabled,
      status: row.connection.status.toLowerCase(),
    },
    notes: row.notes,
    enabled: row.enabled,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class ModelService {
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

  async list(input: unknown = {}) {
    const parsed = listModelsSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid model filters");
    const value = parsed.data;
    const rows = await this.database.modelDefinition.findMany({
      where: {
        applicationId: this.applicationId(),
        ...(value.provider === undefined ? {} : { provider: value.provider }),
        ...(value.connection_id === undefined ? {} : { connectionId: value.connection_id }),
        ...(value.task_type === undefined ? {} : { taskType: taskTypeToDatabase[value.task_type] }),
        ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
      },
      include: { connection: { select: connectionSelect } },
      orderBy: { id: "asc" },
      take: value.limit + 1,
      ...(value.cursor === undefined ? {} : { cursor: { id: value.cursor }, skip: 1 }),
    });
    const hasMore = rows.length > value.limit;
    const page = rows.slice(0, value.limit);
    return {
      models: page.map(present),
      next_cursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async get(id: string) {
    const applicationId = this.applicationId();
    const row = await this.database.modelDefinition.findFirst({
      where: { id, applicationId },
      include: {
        application: { select: { baseCurrency: true } },
        connection: { select: connectionSelect },
      },
    });
    if (row === null) throw new NotFoundException("Model not found");
    const [aggregate, references, unresolved, ratingIssues] = await Promise.all([
      this.database.applicationUsageRating.aggregate({
        where: { applicationId, modelId: row.id },
        _count: { _all: true },
        _sum: { totalTokens: true, providerCost: true, aiuMicros: true },
      }),
      this.virtualModelReferences(row.id),
      this.database.usageEventRegistry.findMany({
        where: { applicationId, requestModel: row.requestModel, realModelId: null },
        select: { eventId: true, eventTime: true, lastError: true },
        orderBy: [{ eventTime: "desc" }, { eventId: "desc" }],
        take: 8,
      }),
      this.database.applicationUsageRating.findMany({
        where: {
          applicationId,
          modelId: row.id,
          OR: [{ costStatus: "unpriced" }, { aiuStatus: "unrated" }],
        },
        select: { eventId: true, ratedAt: true, costStatus: true, aiuStatus: true },
        orderBy: [{ ratedAt: "desc" }, { eventId: "desc" }],
        take: 8,
      }),
    ]);
    return {
      ...present(row),
      metrics: presentModelMetrics(aggregate, row.application.baseCurrency),
      virtual_model_references: references,
      recent_issues: presentModelIssues(unresolved, ratingIssues),
    };
  }

  async disableImpact(id: string) {
    const row = await this.database.modelDefinition.findFirst({
      where: { id, applicationId: this.applicationId() },
    });
    if (row === null) throw new NotFoundException("Model not found");
    const virtualModels = await this.virtualModelReferences(row.id);
    return {
      model: { id: row.id, name: row.name, request_model: row.requestModel },
      virtual_models: virtualModels,
      reference_count: virtualModels.length,
      affects_routing: virtualModels.length > 0,
    };
  }

  async create(input: unknown) {
    const parsed = createModelSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid model");
    const value = parsed.data;
    const applicationId = this.applicationId();
    await this.requireConnection(applicationId, value.connection_id);
    try {
      const row = await this.database.modelDefinition.create({
        data: {
          applicationId,
          connectionId: value.connection_id,
          name: value.name,
          requestModel: value.request_model,
          provider: value.provider,
          taskType: taskTypeToDatabase[value.task_type],
          capabilitiesJson: value.capabilities ?? [],
          notes: value.notes ?? null,
        },
        include: { connection: { select: connectionSelect } },
      });
      await this.audit.record({
        action: "model.create",
        objectType: "model",
        objectId: row.id,
        after: { name: row.name, request_model: row.requestModel },
        reason: "Created model",
      });
      return present(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("This model identifier already exists on the connection");
      }
      throw error;
    }
  }

  async update(id: string, input: unknown) {
    const parsed = updateModelSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid model changes");
    const applicationId = this.applicationId();
    const current = await this.database.modelDefinition.findFirst({
      where: { id, applicationId },
      include: { connection: { select: connectionSelect } },
    });
    if (current === null) throw new NotFoundException("Model not found");
    const value = parsed.data;
    if (value.connection_id !== undefined) {
      await this.requireConnection(applicationId, value.connection_id);
    }
    const row = await this.database.modelDefinition.update({
      where: { id: current.id },
      data: {
        ...(value.name === undefined ? {} : { name: value.name }),
        ...(value.connection_id === undefined ? {} : { connectionId: value.connection_id }),
        ...(value.request_model === undefined ? {} : { requestModel: value.request_model }),
        ...(value.provider === undefined ? {} : { provider: value.provider }),
        ...(value.task_type === undefined ? {} : { taskType: taskTypeToDatabase[value.task_type] }),
        ...(value.capabilities === undefined ? {} : { capabilitiesJson: value.capabilities }),
        ...(value.notes === undefined ? {} : { notes: value.notes }),
        ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
      },
      include: { connection: { select: connectionSelect } },
    });
    await this.audit.record({
      action: "model.update",
      objectType: "model",
      objectId: row.id,
      before: { name: current.name, request_model: current.requestModel, enabled: current.enabled },
      after: { name: row.name, request_model: row.requestModel, enabled: row.enabled },
      reason: "Updated model",
    });
    return present(row);
  }

  async delete(id: string) {
    const applicationId = this.applicationId();
    const current = await this.database.modelDefinition.findFirst({
      where: { id, applicationId },
      include: {
        _count: { select: { defaultFor: true, routeTargets: true, ruleTargets: true } },
      },
    });
    if (current === null) throw new NotFoundException("Model not found");
    const references = current._count;
    if (references.defaultFor + references.routeTargets + references.ruleTargets > 0) {
      throw new ConflictException({
        message: "Remove this model from its virtual models before deleting it",
        references: {
          default_models: references.defaultFor,
          routes: references.routeTargets,
          conditions: references.ruleTargets,
        },
      });
    }
    await this.database.modelDefinition.delete({ where: { id: current.id } });
    await this.audit.record({
      action: "model.delete",
      objectType: "model",
      objectId: current.id,
      before: { name: current.name, request_model: current.requestModel },
      reason: "Deleted model",
    });
    return { deleted: true };
  }

  private async requireConnection(applicationId: string, connectionId: string): Promise<void> {
    const connection = await this.database.callConnection.findFirst({
      where: { id: connectionId, applicationId },
      select: { id: true },
    });
    if (connection === null) throw new BadRequestException("Connection not found");
  }

  private async virtualModelReferences(modelId: string) {
    const applicationId = this.applicationId();
    const rows = await this.database.virtualModel.findMany({
      where: {
        applicationId,
        OR: [
          { defaultModelId: modelId },
          { targets: { some: { modelId } } },
          { rules: { some: { targetModelId: modelId } } },
        ],
      },
      select: {
        id: true,
        name: true,
        displayName: true,
        enabled: true,
        defaultModelId: true,
        targets: { where: { modelId }, select: { id: true } },
        rules: { where: { targetModelId: modelId }, select: { id: true } },
      },
      orderBy: [{ enabled: "desc" }, { displayName: "asc" }],
    });
    return presentModelReferences(modelId, rows);
  }
}

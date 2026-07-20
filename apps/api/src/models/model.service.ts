import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { Prisma, type DatabaseClient } from "@tokenpilot/db";

import { AuditContextService } from "../audit-context.js";
import { AuditService } from "../audit.service.js";
import { DATABASE_CLIENT } from "../tokens.js";
import {
  presentModelIssues,
  presentModelMetrics,
  presentModelReferences,
} from "./model-details.js";
import { createModelSchema, updateModelSchema } from "./model.schemas.js";

const knownProviders = new Set([
  "anthropic",
  "azure",
  "bedrock",
  "cohere",
  "gemini",
  "groq",
  "mistral",
  "ollama",
  "openai",
  "vertex_ai",
]);

function inferredProvider(tag: string): string | null {
  const prefix = tag.split("/", 1)[0]?.toLowerCase();
  return prefix !== undefined && knownProviders.has(prefix) ? prefix : null;
}

function present(row: {
  readonly id: string;
  readonly name: string;
  readonly litellmTag: string;
  readonly provider: string | null;
  readonly capabilitiesJson: unknown;
  readonly notes: string | null;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    litellm_tag: row.litellmTag,
    provider: row.provider,
    capabilities: row.capabilitiesJson,
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

  async list() {
    const rows = await this.database.modelDefinition.findMany({
      where: { applicationId: this.applicationId() },
      orderBy: [{ enabled: "desc" }, { name: "asc" }],
    });
    return { models: rows.map(present) };
  }

  async get(id: string) {
    const applicationId = this.applicationId();
    const row = await this.database.modelDefinition.findFirst({
      where: { id, applicationId },
      include: { application: { select: { baseCurrency: true } } },
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
        where: { applicationId, modelTag: row.litellmTag, realModelId: null },
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
      model: { id: row.id, name: row.name, litellm_tag: row.litellmTag },
      virtual_models: virtualModels,
      reference_count: virtualModels.length,
      affects_routing: virtualModels.length > 0,
    };
  }

  async create(input: unknown) {
    const parsed = createModelSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid model");
    const value = parsed.data;
    try {
      const row = await this.database.modelDefinition.create({
        data: {
          applicationId: this.applicationId(),
          name: value.name,
          litellmTag: value.litellm_tag,
          provider: value.provider ?? inferredProvider(value.litellm_tag),
          capabilitiesJson: value.capabilities ?? [],
          notes: value.notes ?? null,
        },
      });
      await this.audit.record({
        action: "model.create",
        objectType: "model",
        objectId: row.id,
        after: { name: row.name, litellm_tag: row.litellmTag },
        reason: "Created model",
      });
      return present(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("This LiteLLM tag already exists in the application");
      }
      throw error;
    }
  }

  async update(id: string, input: unknown) {
    const parsed = updateModelSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid model changes");
    const current = await this.database.modelDefinition.findFirst({
      where: { id, applicationId: this.applicationId() },
    });
    if (current === null) throw new NotFoundException("Model not found");
    const value = parsed.data;
    const row = await this.database.modelDefinition.update({
      where: { id: current.id },
      data: {
        ...(value.name === undefined ? {} : { name: value.name }),
        ...(value.litellm_tag === undefined ? {} : { litellmTag: value.litellm_tag }),
        ...(value.provider === undefined ? {} : { provider: value.provider }),
        ...(value.capabilities === undefined ? {} : { capabilitiesJson: value.capabilities }),
        ...(value.notes === undefined ? {} : { notes: value.notes }),
        ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
      },
    });
    await this.audit.record({
      action: "model.update",
      objectType: "model",
      objectId: row.id,
      before: { name: current.name, litellm_tag: current.litellmTag, enabled: current.enabled },
      after: { name: row.name, litellm_tag: row.litellmTag, enabled: row.enabled },
      reason: "Updated model",
    });
    return present(row);
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

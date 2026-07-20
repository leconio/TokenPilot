import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { PublicationStatus, type DatabaseClient, type Prisma } from "@tokenpilot/db";

import { AuditContextService } from "../audit-context.js";
import { AuditService } from "../audit.service.js";
import { DATABASE_CLIENT } from "../tokens.js";
import {
  aiuToMicros,
  aiuUsage,
  costUsage,
  microsToAiu,
  presentRates,
  trimmedDecimal,
} from "./model-pricing.catalog.js";
import { saveModelAiuSchema, saveModelCostSchema } from "./model-pricing.schemas.js";

@Injectable()
export class ModelPricingService {
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

  private async requireModel(id: string) {
    const row = await this.database.modelDefinition.findFirst({
      where: { id, applicationId: this.applicationId() },
      select: {
        id: true,
        name: true,
        requestModel: true,
        application: { select: { baseCurrency: true } },
      },
    });
    if (row === null) throw new NotFoundException("Model not found");
    return row;
  }

  async get(modelId: string, at: Date = new Date()) {
    const model = await this.requireModel(modelId);
    const [cost, aiu] = await Promise.all([
      this.database.modelCostVersion.findFirst({
        where: {
          applicationId: this.applicationId(),
          modelId: model.id,
          status: PublicationStatus.PUBLISHED,
          effectiveFrom: { lte: at },
        },
        include: { items: true },
        orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
      }),
      this.database.modelAiuVersion.findFirst({
        where: {
          applicationId: this.applicationId(),
          modelId: model.id,
          status: PublicationStatus.PUBLISHED,
          effectiveFrom: { lte: at },
        },
        include: { items: true },
        orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
      }),
    ]);
    return {
      model: { id: model.id, name: model.name, request_model: model.requestModel },
      cost:
        cost === null
          ? null
          : {
              version: cost.version,
              currency: cost.currency,
              effective_from: cost.effectiveFrom.toISOString(),
              rates: presentRates(costUsage, cost.items, (item) => trimmedDecimal(item.unitPrice)),
            },
      aiu:
        aiu === null
          ? null
          : {
              version: aiu.version,
              effective_from: aiu.effectiveFrom.toISOString(),
              rates: presentRates(aiuUsage, aiu.items, (item) =>
                microsToAiu(item.aiuMicrosPerUnit),
              ),
            },
    };
  }

  async saveCost(modelId: string, input: unknown, at: Date = new Date()) {
    const parsed = saveModelCostSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid model cost");
    const model = await this.requireModel(modelId);
    const applicationId = this.applicationId();
    const latest = await this.database.modelCostVersion.findFirst({
      where: { applicationId, modelId: model.id },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const items: Prisma.ModelCostItemCreateWithoutVersionInput[] = costUsage.flatMap(
      ({ field, usageType, unitSize }) => {
        const value = parsed.data[field];
        return value === null || value === undefined
          ? []
          : [{ usageType, unitSize, unitPrice: value }];
      },
    );
    items.push(
      ...(parsed.data.custom_units ?? []).map((item) => ({
        usageType: "custom_unit",
        unitKey: item.unit_key,
        unitSize: item.unit_size,
        unitPrice: item.rate,
      })),
    );
    const row = await this.database.$transaction(async (transaction) => {
      await transaction.modelCostVersion.updateMany({
        where: { applicationId, modelId: model.id, status: PublicationStatus.PUBLISHED },
        data: { status: PublicationStatus.RETIRED },
      });
      return transaction.modelCostVersion.create({
        data: {
          applicationId,
          modelId: model.id,
          version: (latest?.version ?? 0) + 1,
          currency: model.application.baseCurrency,
          effectiveFrom: at,
          items: { create: items },
        },
        include: { items: true },
      });
    });
    await this.audit.record({
      action: "model.cost.publish",
      objectType: "model",
      objectId: model.id,
      after: { version: row.version, currency: row.currency },
      reason: "Published model cost",
    });
    return this.get(model.id, at);
  }

  async saveAiu(modelId: string, input: unknown, at: Date = new Date()) {
    const parsed = saveModelAiuSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid model AIU rate");
    const model = await this.requireModel(modelId);
    const applicationId = this.applicationId();
    const latest = await this.database.modelAiuVersion.findFirst({
      where: { applicationId, modelId: model.id },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const items: Prisma.ModelAiuItemCreateWithoutVersionInput[] = aiuUsage.flatMap(
      ({ field, usageType, unitSize }) => {
        const value = parsed.data[field];
        return value === null || value === undefined
          ? []
          : [{ usageType, unitSize, aiuMicrosPerUnit: aiuToMicros(value) }];
      },
    );
    items.push(
      ...(parsed.data.custom_units ?? []).map((item) => ({
        usageType: "custom_unit",
        unitKey: item.unit_key,
        unitSize: item.unit_size,
        aiuMicrosPerUnit: aiuToMicros(item.rate),
      })),
    );
    const row = await this.database.$transaction(async (transaction) => {
      await transaction.modelAiuVersion.updateMany({
        where: { applicationId, modelId: model.id, status: PublicationStatus.PUBLISHED },
        data: { status: PublicationStatus.RETIRED },
      });
      return transaction.modelAiuVersion.create({
        data: {
          applicationId,
          modelId: model.id,
          version: (latest?.version ?? 0) + 1,
          effectiveFrom: at,
          items: { create: items },
        },
        include: { items: true },
      });
    });
    await this.audit.record({
      action: "model.aiu.publish",
      objectType: "model",
      objectId: model.id,
      after: { version: row.version },
      reason: "Published model AIU rate",
    });
    return this.get(model.id, at);
  }
}

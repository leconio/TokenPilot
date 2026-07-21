import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import {
  modelCostConditionSchema,
  saveModelCostRulesSchema,
  type ModelCostCondition,
} from "@tokenpilot/contracts";
import {
  PropertyDataType,
  PropertyStatus,
  PublicationStatus,
  type DatabaseClient,
  type Prisma,
} from "@tokenpilot/db";

import { AuditContextService } from "../audit-context.js";
import { AuditService } from "../audit.service.js";
import { DATABASE_CLIENT } from "../tokens.js";
import {
  aiuToMicros,
  aiuUsage,
  microsToAiu,
  presentRates,
  trimmedDecimal,
} from "./model-pricing.catalog.js";
import { saveModelAiuSchema } from "./model-pricing.schemas.js";

const propertyOperators: Readonly<Record<PropertyDataType, ReadonlySet<string>>> = {
  TEXT: new Set(["equals", "not_equals", "contains", "starts_with", "is_set", "is_not_set"]),
  NUMBER: new Set([
    "equals",
    "not_equals",
    "greater_than",
    "greater_or_equal",
    "less_than",
    "less_or_equal",
    "between",
    "is_set",
    "is_not_set",
  ]),
  BOOLEAN: new Set(["equals", "not_equals", "is_set", "is_not_set"]),
  DATETIME: new Set([
    "equals",
    "not_equals",
    "greater_than",
    "greater_or_equal",
    "less_than",
    "less_or_equal",
    "between",
    "is_set",
    "is_not_set",
  ]),
  ENUM: new Set(["equals", "not_equals", "one_of", "is_set", "is_not_set"]),
  TEXT_LIST: new Set(["contains_any", "contains_all", "is_set", "is_not_set"]),
};

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function propertyIdentity(scope: "event" | "user", key: string): string {
  return `${scope}:${key}`;
}

function storedConditions(value: Prisma.JsonValue): readonly ModelCostCondition[] {
  return modelCostConditionSchema.array().parse(value);
}

function propertyValuesMatch(dataType: PropertyDataType, values: readonly unknown[]): boolean {
  if (dataType === PropertyDataType.NUMBER)
    return values.every((value) => typeof value === "number");
  if (dataType === PropertyDataType.BOOLEAN)
    return values.every((value) => typeof value === "boolean");
  if (dataType === PropertyDataType.DATETIME) {
    return values.every((value) => typeof value === "string" && Number.isFinite(Date.parse(value)));
  }
  return values.every((value) => typeof value === "string");
}

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
    const [cost, aiu, properties] = await Promise.all([
      this.database.modelCostVersion.findFirst({
        where: {
          applicationId: this.applicationId(),
          modelId: model.id,
          status: PublicationStatus.PUBLISHED,
          effectiveFrom: { lte: at },
        },
        include: {
          rules: { include: { items: true }, orderBy: { priority: "asc" } },
        },
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
      this.database.propertyDefinition.findMany({
        where: { applicationId: this.applicationId(), status: PropertyStatus.ACTIVE },
        select: { key: true, scope: true, dataType: true },
      }),
    ]);
    const propertyTypes = new Map(
      properties.map((property) => [
        propertyIdentity(property.scope === "EVENT" ? "event" : "user", property.key),
        property.dataType,
      ]),
    );
    return {
      model: { id: model.id, name: model.name, request_model: model.requestModel },
      cost_currency: model.application.baseCurrency,
      cost:
        cost === null
          ? null
          : {
              version: cost.version,
              currency: cost.currency,
              effective_from: cost.effectiveFrom.toISOString(),
              source_priority: "reported_first" as const,
              rules: cost.rules.map((rule) => ({
                id: rule.id,
                name: rule.name,
                priority: rule.priority,
                match: rule.matchMode,
                conditions: storedConditions(rule.conditionsJson).map((condition) =>
                  condition.kind === "property"
                    ? {
                        ...condition,
                        data_type:
                          propertyTypes.get(propertyIdentity(condition.scope, condition.key)) ??
                          "TEXT",
                      }
                    : condition,
                ),
                fixed_amount: rule.fixedAmount === null ? null : trimmedDecimal(rule.fixedAmount),
                rates: rule.items.map((item) => ({
                  usage_type: item.usageType,
                  ...(item.unitKey === "" ? {} : { unit_key: item.unitKey }),
                  amount_per_unit: trimmedDecimal(item.amountPerUnit),
                })),
              })),
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

  private async validateCostRuleProperties(
    applicationId: string,
    conditions: readonly ModelCostCondition[],
  ): Promise<void> {
    const requested = conditions.filter(
      (condition): condition is Extract<ModelCostCondition, { kind: "property" }> =>
        condition.kind === "property",
    );
    if (requested.length === 0) return;
    const definitions = await this.database.propertyDefinition.findMany({
      where: {
        applicationId,
        status: PropertyStatus.ACTIVE,
        key: { in: [...new Set(requested.map((condition) => condition.key))] },
      },
      select: { key: true, scope: true, dataType: true, sensitive: true },
    });
    const indexed = new Map(
      definitions.map((definition) => [
        propertyIdentity(definition.scope === "EVENT" ? "event" : "user", definition.key),
        definition,
      ]),
    );
    for (const condition of requested) {
      const definition = indexed.get(propertyIdentity(condition.scope, condition.key));
      if (definition === undefined || definition.sensitive) {
        throw new BadRequestException(`Field ${condition.key} is not available for cost rules`);
      }
      if (!propertyOperators[definition.dataType].has(condition.operator)) {
        throw new BadRequestException(`The selected comparison is not valid for ${condition.key}`);
      }
      if (!propertyValuesMatch(definition.dataType, condition.values)) {
        throw new BadRequestException(`The condition value does not match ${condition.key}`);
      }
    }
  }

  async saveCostRules(modelId: string, input: unknown, at: Date = new Date()) {
    const parsed = saveModelCostRulesSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid model cost rules");
    const model = await this.requireModel(modelId);
    const applicationId = this.applicationId();
    await this.validateCostRuleProperties(
      applicationId,
      parsed.data.rules.flatMap((rule) => rule.conditions),
    );
    const latest = await this.database.modelCostVersion.findFirst({
      where: { applicationId, modelId: model.id },
      orderBy: { version: "desc" },
      select: { version: true },
    });
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
          rules: {
            create: parsed.data.rules.map((rule, priority) => ({
              name: rule.name,
              priority,
              matchMode: rule.match,
              conditionsJson: json(rule.conditions),
              fixedAmount: rule.fixed_amount ?? null,
              items: {
                create: rule.rates.map((rate) => ({
                  usageType: rate.usage_type,
                  unitKey: rate.unit_key ?? "",
                  amountPerUnit: rate.amount_per_unit,
                })),
              },
            })),
          },
        },
        include: { rules: { include: { items: true } } },
      });
    });
    await this.audit.record({
      action: "model.cost-rules.publish",
      objectType: "model",
      objectId: model.id,
      after: { version: row.version, currency: row.currency, rule_count: row.rules.length },
      reason: "Published conditional model cost rules",
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

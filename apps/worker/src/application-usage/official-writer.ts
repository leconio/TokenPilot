import { createHash } from "node:crypto";

import {
  aiuQuotaPeriodWindow,
  materializeEffectiveAiuQuotaPolicy,
  Prisma,
  QuotaPeriodType,
} from "@tokenpilot/db";

import type {
  OfficialCommitResult,
  OfficialSettlementWriter,
  PipelineOutboxMessage,
  PipelineSettlementContext,
} from "../pipeline/types.js";
import type { ApplicationQuotaArtifact } from "./stage-handlers.js";
import type { AiuRatingArtifact, CostRatingArtifact } from "./rating.js";
import { applyUserAiu } from "./user-aiu-settlement.js";

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function fingerprint(...parts: readonly string[]): string {
  return `sha256:${createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex")}`;
}

function costArtifact(value: unknown): CostRatingArtifact {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as { readonly kind?: unknown }).kind !== "application_cost"
  ) {
    throw new TypeError("Application cost rating is missing");
  }
  return value as CostRatingArtifact;
}

function aiuArtifact(value: unknown): AiuRatingArtifact {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as { readonly kind?: unknown }).kind !== "application_aiu"
  ) {
    throw new TypeError("Application AIU rating is missing");
  }
  return value as AiuRatingArtifact;
}

function quotaArtifact(value: unknown): ApplicationQuotaArtifact {
  if (
    value !== null &&
    typeof value === "object" &&
    (value as { readonly kind?: unknown }).kind === "application_quota"
  ) {
    return value as ApplicationQuotaArtifact;
  }
  return { kind: "application_quota", reservationId: null };
}

function attemptOutcome(status: string): string {
  if (status === "failure") return "failure";
  if (status === "cancelled") return "cancelled";
  if (status === "timeout") return "timeout";
  if (status === "success") return "success";
  return "unknown";
}

function tokenTotals(context: PipelineSettlementContext) {
  let input = new Prisma.Decimal(0);
  let output = new Prisma.Decimal(0);
  let cached = new Prisma.Decimal(0);
  for (const line of context.normalized.usage_lines) {
    const quantity = new Prisma.Decimal(line.quantity);
    if (
      line.usage_type === "uncached_input_token" ||
      line.usage_type === "cache_read_input_token" ||
      line.usage_type === "cache_write_input_token" ||
      line.usage_type === "embedding_token"
    ) {
      input = input.add(quantity);
    }
    if (
      line.usage_type === "cache_read_input_token" ||
      line.usage_type === "cache_write_input_token"
    ) {
      cached = cached.add(quantity);
    }
    if (line.usage_type === "output_token" || line.usage_type === "reasoning_output_token") {
      output = output.add(quantity);
    }
  }
  return { input, output, cached, total: input.add(output) };
}

function ratingBase(context: PipelineSettlementContext, ratingId: string, modelId: string) {
  const event = context.event;
  return {
    schema_version: "2.0",
    application_id: context.applicationId,
    event_id: event.event_id,
    request_id: event.request.request_id,
    attempt_id: event.request.attempt_id,
    attempt_index: event.request.attempt_index,
    is_final_attempt: event.request.is_final_attempt,
    operation_id: event.request.operation_id,
    event_time: event.event_time,
    instance_id: event.source.instance_id,
    user_id: event.user.user_id,
    virtual_model: event.model.virtual_model ?? null,
    model_id: modelId,
    connection_id: event.model.connection_id ?? null,
    connection_driver: event.model.connection_driver ?? null,
    request_model: event.model.request_model,
    provider: event.model.provider,
    attempt_outcome: attemptOutcome(event.result.status),
    route_reason: event.route?.reason ?? null,
    rating_id: ratingId,
    replaces_rating_id: null,
  };
}

function ratingOutboxes(
  context: PipelineSettlementContext,
  rating: { readonly id: string; readonly modelId: string },
  cost: CostRatingArtifact,
  aiu: AiuRatingArtifact,
): readonly PipelineOutboxMessage[] {
  const base = ratingBase(context, rating.id, rating.modelId);
  const costFingerprint = fingerprint(
    context.applicationId,
    context.event.event_id,
    "cost",
    cost.source ?? "unpriced",
    cost.versionId ?? "unpriced",
    cost.ruleId ?? "no-rule",
    cost.total ?? "",
  );
  const aiuFingerprint = fingerprint(
    context.applicationId,
    context.event.event_id,
    "aiu",
    aiu.versionId ?? "unrated",
    aiu.totalMicros?.toString() ?? "",
  );
  const costType =
    cost.status === "official" ? "provider_cost.official_delta" : "provider_cost.unpriced";
  const aiuType = aiu.status === "official" ? "aiu.official_delta" : "aiu.decision";
  return [
    {
      aggregateType: "application_usage_rating",
      aggregateId: rating.id,
      eventType: costType,
      idempotencyKey: `application-rating:${context.applicationId}:${context.event.event_id}:cost`,
      payload: json({
        ...base,
        status: cost.status,
        rating_fingerprint: costFingerprint,
        price_version_id: cost.versionId,
        calculation_version: "conditional-model-cost-1",
        cost_source: cost.source,
        cost_rule_id: cost.ruleId,
        cost_rule_name: cost.ruleName,
        total_amount: cost.total ?? "0.000000000000000000",
        currency: cost.currency,
        deltas: [
          {
            rating_event_id: `${rating.id}:cost`,
            rating_sign: 1,
            rating_stage: cost.status === "official" ? "official" : "unpriced",
            amount: cost.total,
            currency: cost.currency,
            price_version_id: cost.versionId,
            calculation_version: "conditional-model-cost-1",
            rating_fingerprint: costFingerprint,
            reason:
              cost.status === "official"
                ? cost.source === "rule"
                  ? `matched model cost rule: ${cost.ruleName ?? cost.ruleId ?? "unknown"}`
                  : cost.source === "reported_estimate"
                    ? "source-reported model cost estimate"
                    : "source-reported model cost"
                : "no reported model cost or matching cost rule",
          },
        ],
      }),
    },
    {
      aggregateType: "application_usage_rating",
      aggregateId: rating.id,
      eventType: aiuType,
      idempotencyKey: `application-rating:${context.applicationId}:${context.event.event_id}:aiu`,
      payload: json({
        ...base,
        status: aiu.status,
        rating_fingerprint: aiuFingerprint,
        rate_version_id: aiu.versionId,
        calculation_version: "application-model-aiu-1",
        total_aiu_micros: aiu.totalMicros?.toString() ?? null,
        deltas: [
          {
            rating_event_id: `${rating.id}:aiu`,
            rating_sign: 1,
            rating_stage: aiu.status === "official" ? "official" : "unrated",
            rating_fingerprint: aiuFingerprint,
            total_aiu_micros: aiu.totalMicros?.toString() ?? null,
            aiu_rate_version_id: aiu.versionId,
            calculation_version: "application-model-aiu-1",
            reason:
              aiu.status === "official"
                ? "application model AIU rating"
                : "application model AIU rate is not configured",
            lines: aiu.lines.map((line) => ({
              usage_type: line.usage_type,
              unit_key: line.unit_key || null,
              aiu_micros: line.charged_aiu_micros,
            })),
          },
        ],
      }),
    },
  ];
}

export class ApplicationUsageOfficialWriter implements OfficialSettlementWriter {
  async commit(
    transaction: Prisma.TransactionClient,
    context: PipelineSettlementContext,
  ): Promise<OfficialCommitResult> {
    const cost = costArtifact(context.providerCost);
    const aiu = aiuArtifact(context.aiu);
    const quota = quotaArtifact(context.quota);
    const registry = await transaction.usageEventRegistry.findFirstOrThrow({
      where: { applicationId: context.applicationId, eventId: context.event.event_id },
      select: { applicationUserId: true, reservationId: true },
    });
    const modelId = context.resolution.modelId;
    if (modelId === null) {
      return {
        metrics: {
          providerCostUnpriced: true,
          aiuUnrated: true,
        },
      };
    }
    const tokens = tokenTotals(context);
    const existing = await transaction.applicationUsageRating.findUnique({
      where: {
        applicationId_eventId: {
          applicationId: context.applicationId,
          eventId: context.event.event_id,
        },
      },
    });
    const rating =
      existing ??
      (await transaction.applicationUsageRating.create({
        data: {
          applicationId: context.applicationId,
          eventId: context.event.event_id,
          userId: registry.applicationUserId,
          modelId,
          virtualModel: context.event.model.virtual_model ?? null,
          costStatus: cost.status,
          providerCost: cost.total,
          currency: cost.currency,
          costVersionId: cost.versionId,
          costLinesJson: json(cost.lines),
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          cachedTokens: tokens.cached,
          totalTokens: tokens.total,
          aiuStatus: aiu.status,
          aiuMicros: aiu.totalMicros,
          aiuVersionId: aiu.versionId,
          aiuLinesJson: json(aiu.lines),
        },
      }));
    if (aiu.totalMicros !== null) {
      const application = await transaction.application.findUniqueOrThrow({
        where: { id: context.applicationId },
        select: { timezone: true },
      });
      await materializeEffectiveAiuQuotaPolicy(transaction, {
        applicationId: context.applicationId,
        userId: registry.applicationUserId,
        reason: "Applied the effective AIU quota rule during usage settlement",
        window: (policy) =>
          policy.periodType === QuotaPeriodType.FIXED_WINDOW
            ? { start: policy.startsAt!, end: policy.endsAt! }
            : aiuQuotaPeriodWindow(policy.periodType, application.timezone, new Date()),
      });
    }
    const consumption = await applyUserAiu(
      transaction,
      context.applicationId,
      registry.applicationUserId,
      quota.reservationId ?? registry.reservationId,
      context.event.event_id,
      aiu.totalMicros,
    );
    return {
      additionalOutboxMessages: ratingOutboxes(context, rating, cost, aiu),
      metrics: {
        ...(cost.status === "unpriced" ? { providerCostUnpriced: true } : {}),
        ...(aiu.status === "unrated" ? { aiuUnrated: true } : {}),
        ...(aiu.totalMicros === null ? {} : { ratedAiuMicros: aiu.totalMicros.toString() }),
        ...(consumption === null
          ? {}
          : {
              consumedAiuMicros: consumption.consumed.toString(),
              quotaDecision: consumption.decision,
            }),
      },
    };
  }
}

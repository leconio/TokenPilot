import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";

import type { DatabaseClient } from "@tokenpilot/db";

import { AuditContextService } from "./audit-context.js";
import { sanitizeUntrustedUsageEvent } from "./privacy.js";
import { redactSensitiveData, redactSensitiveString } from "./security.js";
import { DATABASE_CLIENT } from "./tokens.js";
import { loadUsageOutputPolicy, redactSensitivePropertyKeys } from "./reports/usage-output.js";

function lower(value: { toString(): string } | null | undefined): string | null {
  return value?.toString().toLowerCase() ?? null;
}

function jsonArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

@Injectable()
export class RequestDetailsService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(AuditContextService) private readonly context: AuditContextService,
  ) {}

  public async find(requestId: string) {
    const applicationId = this.context.current().applicationId;
    if (applicationId === undefined) throw new ForbiddenException("Application context required");
    const events = await this.database.usageEventRegistry.findMany({
      where: { applicationId, requestId },
      orderBy: [{ eventTime: "asc" }, { attemptId: "asc" }],
      include: {
        realModel: { select: { id: true, name: true, requestModel: true } },
        applicationRating: {
          include: { model: { select: { id: true, name: true, requestModel: true } } },
        },
        inbox: {
          select: {
            payloadJson: true,
            payloadPurgedAt: true,
            status: true,
            stage: true,
            attemptCount: true,
            lastError: true,
            deadLetterEvents: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
          },
        },
      },
    });
    if (events.length === 0) throw new NotFoundException("Request was not found");

    const outputPolicy = await loadUsageOutputPolicy(this.database, applicationId);
    const allSensitiveKeys = new Set([
      ...outputPolicy.sensitiveEventKeys,
      ...outputPolicy.sensitiveUserKeys,
    ]);

    const eventIds = events.map((event) => event.eventId);
    const ratingIds = events.flatMap((event) =>
      event.applicationRating === null ? [] : [event.applicationRating.id],
    );
    const [outbox, ledger, audit] = await Promise.all([
      this.database.pipelineOutbox.findMany({
        where: { applicationId, aggregateId: { in: [...eventIds, ...ratingIds] } },
        orderBy: [{ id: "asc" }],
        select: {
          aggregateId: true,
          eventType: true,
          status: true,
          attemptCount: true,
          sentAt: true,
          lastError: true,
        },
      }),
      this.database.userAiuLedgerEntry.findMany({
        where: { applicationId, sourceEventId: { in: eventIds } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      this.database.auditLog.findMany({
        where: { applicationId, objectId: { in: [requestId, ...eventIds] } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          action: true,
          objectType: true,
          objectId: true,
          afterJson: true,
          reason: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      request_id: requestId,
      attempts: events.map((event) => {
        const rating = event.applicationRating;
        const model = rating?.model ?? event.realModel;
        const aggregateIds = new Set([event.eventId, ...(rating === null ? [] : [rating.id])]);
        return {
          request_id: event.requestId,
          attempt_id: event.attemptId,
          attempt_index: event.attemptIndex,
          is_final_attempt: event.isFinalAttempt,
          operation_id: event.operationId,
          user_id: event.externalUserId,
          display_user: event.userName,
          virtual_model: event.virtualModel,
          model_id: rating?.modelId ?? event.realModelId,
          connection_id: event.connectionId,
          connection_driver: event.connectionDriver?.toLowerCase() ?? null,
          model_name: model?.name ?? null,
          request_model: model?.requestModel ?? event.requestModel,
          provider: event.provider,
          route_reason: event.routeReason,
          fallback_from: event.fallbackFrom,
          event_time: event.eventTime.toISOString(),
          received_at: event.receivedAt.toISOString(),
          status: event.resultStatus,
          versions: {
            schema: event.schemaVersion,
            application: event.applicationVersion,
            sdk: event.sdkVersion,
            connector: event.connectorVersion,
            configuration: event.configVersion,
          },
          properties: {
            event: redactSensitivePropertyKeys(
              event.eventPropertiesJson,
              outputPolicy.sensitiveEventKeys,
            ),
            user: redactSensitivePropertyKeys(
              event.userPropertiesJson,
              outputPolicy.sensitiveUserKeys,
            ),
          },
          raw_event: {
            event_id: event.eventId,
            processing_status: lower(event.processingStage),
            error: event.lastError === null ? null : redactSensitiveString(event.lastError),
            payload_state:
              event.inbox?.payloadJson === null || event.inbox === null ? "purged" : "retained",
            payload:
              event.inbox?.payloadJson === null || event.inbox === null
                ? null
                : redactSensitivePropertyKeys(
                    sanitizeUntrustedUsageEvent(event.inbox.payloadJson),
                    allSensitiveKeys,
                  ),
          },
          model_resolution: {
            status: model === null ? "unmapped" : "matched",
            model_id: rating?.modelId ?? event.realModelId,
            request_model: model?.requestModel ?? event.requestModel,
          },
          usage: {
            input_tokens: rating?.inputTokens.toString() ?? "0",
            cached_input_tokens: rating?.cachedTokens.toString() ?? "0",
            output_tokens: rating?.outputTokens.toString() ?? "0",
            total_tokens: rating?.totalTokens.toString() ?? "0",
          },
          model_cost:
            rating === null
              ? null
              : {
                  status: rating.costStatus,
                  total: rating.providerCost?.toString() ?? null,
                  currency: rating.currency,
                  version_id: rating.costVersionId,
                  lines: jsonArray(rating.costLinesJson),
                },
          aiu:
            rating === null
              ? null
              : {
                  status: rating.aiuStatus,
                  total_aiu_micros: rating.aiuMicros?.toString() ?? null,
                  version_id: rating.aiuVersionId,
                  lines: jsonArray(rating.aiuLinesJson),
                },
          aiu_history: ledger
            .filter((entry) => entry.sourceEventId === event.eventId)
            .map((entry) => ({
              id: entry.id,
              type: lower(entry.entryType),
              used_change_aiu_micros: entry.consumedDeltaMicros.toString(),
              reserved_change_aiu_micros: entry.reservedDeltaMicros.toString(),
              used_after_aiu_micros: entry.consumedAfterMicros.toString(),
              reserved_after_aiu_micros: entry.reservedAfterMicros.toString(),
              reason: entry.reason,
              created_at: entry.createdAt.toISOString(),
            })),
          projection: outbox
            .filter((message) => aggregateIds.has(message.aggregateId))
            .map((message) => ({
              event_type: message.eventType,
              status: lower(message.status),
              attempt_count: message.attemptCount,
              sent_at: message.sentAt?.toISOString() ?? null,
              error: message.lastError === null ? null : redactSensitiveString(message.lastError),
            })),
          failures: (event.inbox?.deadLetterEvents ?? []).map((failure) => ({
            id: failure.id,
            stage: lower(failure.stage),
            code: failure.errorCode,
            class: failure.errorClass,
            status: lower(failure.status),
            replay_count: failure.replayCount,
            first_failed_at: failure.firstFailedAt.toISOString(),
            resolution: failure.resolution,
          })),
        };
      }),
      audit_history: audit.map((entry) => ({
        action: entry.action,
        object_type: entry.objectType,
        object_id: entry.objectId,
        after: redactSensitivePropertyKeys(redactSensitiveData(entry.afterJson), allSensitiveKeys),
        reason: entry.reason,
        created_at: entry.createdAt.toISOString(),
      })),
    };
  }
}

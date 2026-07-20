import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
  PayloadTooLargeException,
} from "@nestjs/common";
import { z } from "zod";

import { eventIdSchema, usageEventSchema, type UsageEvent } from "@tokenpilot/contracts";
import { type DatabaseClient, Prisma } from "@tokenpilot/db";

import { canonicalJson, canonicalPayloadHash } from "./ingestion/canonical-payload.js";
import {
  validateEventProperties,
  type PropertyDefinitionForValidation,
} from "./ingestion/property-validation.js";
import type {
  UsageBatchResponse,
  UsageIngestionItemResult,
  UsageIngestionOptions,
  ValidatedUsageEvent,
} from "./ingestion/types.js";
import { DATABASE_CLIENT } from "./tokens.js";

const batchEnvelopeSchema = z.strictObject({
  schema_version: z.literal("2.0"),
  batch_id: z.string().min(1).max(256),
  sent_at: z.iso.datetime({ offset: true }),
  events: z.array(z.unknown()).min(1),
});

const DEFAULT_OPTIONS: UsageIngestionOptions = {
  maxBatchSize: 1_000,
  maxBatchBytes: 10 * 1024 * 1024,
  maxEventBytes: 1024 * 1024,
};

export const USAGE_INGESTION_OPTIONS = Symbol("USAGE_INGESTION_OPTIONS");

interface ExistingRegistryIdentity {
  readonly payloadHash: string;
}

function possibleEventId(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const eventId = (value as Readonly<Record<string, unknown>>).event_id;
  return eventIdSchema.safeParse(eventId).success ? (eventId as string) : null;
}

function isUniqueConflict(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") ||
    (typeof error === "object" && error !== null && "code" in error && error.code === "P2002")
  );
}

function statusForExisting(existing: ExistingRegistryIdentity, payloadHash: string) {
  return existing.payloadHash === payloadHash ? ("duplicate" as const) : ("conflict" as const);
}

@Injectable()
export class UsageIngestionService {
  private readonly options: UsageIngestionOptions;

  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Optional()
    @Inject(USAGE_INGESTION_OPTIONS)
    options: Partial<UsageIngestionOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * The request boundary writes only PostgreSQL Registry and Inbox records.
   * Normalization, rating, quota settlement, and analytics delivery run later.
   */
  async ingest(input: unknown, applicationId: string): Promise<UsageBatchResponse> {
    const encodedBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
    if (encodedBytes > this.options.maxBatchBytes) {
      throw new PayloadTooLargeException("Usage batch is too large");
    }
    const batch = batchEnvelopeSchema.safeParse(input);
    if (!batch.success) throw new BadRequestException("Body must satisfy the Usage Batch envelope");
    if (batch.data.events.length > this.options.maxBatchSize) {
      throw new PayloadTooLargeException(
        `Batch contains more than ${this.options.maxBatchSize} events`,
      );
    }

    const definitions = await this.propertyDefinitions(applicationId, batch.data.events);
    const results: UsageIngestionItemResult[] = [];
    for (const [index, candidate] of batch.data.events.entries()) {
      const validated = this.validateEvent(index, candidate, definitions);
      if ("status" in validated) {
        results.push(validated);
        continue;
      }
      results.push(await this.persistEvent(validated, applicationId));
    }

    return {
      schema_version: "2.0",
      batch_id: batch.data.batch_id,
      received_at: new Date().toISOString(),
      accepted: results.filter((result) => result.status === "accepted").length,
      duplicates: results.filter((result) => result.status === "duplicate").length,
      conflicts: results.filter((result) => result.status === "conflict").length,
      rejected: results.filter((result) => result.status === "rejected").length,
      results,
    };
  }

  private validateEvent(
    index: number,
    candidate: unknown,
    definitions: readonly PropertyDefinitionForValidation[],
  ): ValidatedUsageEvent | UsageIngestionItemResult {
    const parsed = usageEventSchema.safeParse(candidate);
    if (!parsed.success) {
      return {
        index,
        event_id: possibleEventId(candidate),
        status: "rejected",
        code: "INVALID_EVENT",
        message: "The event did not satisfy the Usage Event contract.",
      };
    }
    const propertyError = validateEventProperties(parsed.data, definitions);
    if (propertyError !== null) {
      return {
        index,
        event_id: parsed.data.event_id,
        status: "rejected",
        code: "INVALID_PROPERTY",
        message: propertyError,
      };
    }
    const payload = canonicalJson(parsed.data);
    if (Buffer.byteLength(payload, "utf8") > this.options.maxEventBytes) {
      return {
        index,
        event_id: parsed.data.event_id,
        status: "rejected",
        code: "EVENT_TOO_LARGE",
        message: `The canonical event exceeds ${this.options.maxEventBytes} bytes.`,
      };
    }
    return {
      index,
      event: parsed.data,
      payloadHash: canonicalPayloadHash(parsed.data),
    };
  }

  private async persistEvent(
    input: ValidatedUsageEvent,
    applicationId: string,
  ): Promise<UsageIngestionItemResult> {
    try {
      const outcome = await this.database.$transaction(async (transaction) => {
        const existing = await transaction.usageEventRegistry.findFirst({
          where: { applicationId, eventId: input.event.event_id },
          select: { payloadHash: true },
        });
        if (existing !== null) return statusForExisting(existing, input.payloadHash);

        const externalUserId = input.event.user.user_id;
        const userName = input.event.user.display_user ?? null;
        const eventTime = new Date(input.event.event_time);
        const applicationUser = await transaction.applicationUser.upsert({
          where: {
            applicationId_externalId: { applicationId, externalId: externalUserId },
          },
          create: {
            applicationId,
            externalId: externalUserId,
            name: userName,
            propertiesJson: input.event.user_properties ?? {},
            firstSeenAt: eventTime,
            lastSeenAt: eventTime,
          },
          update: {
            ...(userName === null ? {} : { name: userName }),
            ...(input.event.user_properties === undefined
              ? {}
              : { propertiesJson: input.event.user_properties }),
          },
        });
        await Promise.all([
          transaction.applicationUser.updateMany({
            where: { id: applicationUser.id, applicationId, firstSeenAt: { gt: eventTime } },
            data: { firstSeenAt: eventTime },
          }),
          transaction.applicationUser.updateMany({
            where: { id: applicationUser.id, applicationId, lastSeenAt: { lt: eventTime } },
            data: { lastSeenAt: eventTime },
          }),
        ]);

        const reportedModelId = input.event.model.model_id;
        const reportedConnectionId = input.event.model.connection_id;
        const connection =
          reportedConnectionId !== null &&
          reportedConnectionId !== undefined &&
          z.string().uuid().safeParse(reportedConnectionId).success
            ? await transaction.callConnection.findFirst({
                where: { id: reportedConnectionId, applicationId },
                select: { id: true, driver: true },
              })
            : null;
        const modelDefinition =
          reportedModelId !== null &&
          reportedModelId !== undefined &&
          z.string().uuid().safeParse(reportedModelId).success
            ? await transaction.modelDefinition.findFirst({
                where: {
                  id: reportedModelId,
                  applicationId,
                  requestModel: input.event.model.request_model,
                  ...(connection === null ? {} : { connectionId: connection.id }),
                },
                select: { id: true, connectionId: true, connection: { select: { driver: true } } },
              })
            : connection === null
              ? null
              : await transaction.modelDefinition.findFirst({
                  where: {
                    applicationId,
                    connectionId: connection.id,
                    requestModel: input.event.model.request_model,
                    enabled: true,
                  },
                  select: {
                    id: true,
                    connectionId: true,
                    connection: { select: { driver: true } },
                  },
                });

        await transaction.usageEventRegistry.create({
          data: {
            applicationId,
            applicationVersion: input.event.application_version ?? null,
            sdkVersion: input.event.sdk_version ?? null,
            connectorVersion: input.event.connector_version ?? null,
            configVersion: input.event.config_version ?? null,
            externalUserId,
            userName,
            eventPropertiesJson: input.event.event_properties ?? Prisma.JsonNull,
            userPropertiesJson: input.event.user_properties ?? Prisma.JsonNull,
            applicationUserId: applicationUser.id,
            virtualModel: input.event.model.virtual_model ?? null,
            realModelId: modelDefinition?.id ?? null,
            requestModel: input.event.model.request_model,
            connectionId: modelDefinition?.connectionId ?? connection?.id ?? null,
            connectionDriver:
              modelDefinition?.connection.driver.toLowerCase() ??
              connection?.driver.toLowerCase() ??
              input.event.model.connection_driver ??
              null,
            reservationId: input.event.request.reservation_id ?? null,
            eventId: input.event.event_id,
            schemaVersion: input.event.schema_version,
            payloadHash: input.payloadHash,
            requestId: input.event.request.request_id,
            attemptId: input.event.request.attempt_id,
            attemptIndex: input.event.request.attempt_index,
            isFinalAttempt: input.event.request.is_final_attempt,
            operationId: input.event.request.operation_id,
            instanceId: input.event.source.instance_id,
            provider: input.event.model.provider ?? null,
            resultStatus: input.event.result.status,
            routeReason: input.event.route?.reason ?? null,
            fallbackFrom: input.event.route?.fallback_from ?? null,
            eventTime,
            sourceType: input.event.source.type,
            analyticsDimensionsJson: input.event.analytics_dimensions,
            inbox: { create: { payloadJson: input.event } },
          },
          select: { id: true },
        });
        return "accepted" as const;
      });
      return this.itemResult(input, outcome);
    } catch (error) {
      // The unique event ID is the concurrency arbitration point. A writer that
      // lost the race re-reads the immutable hash before classifying the retry.
      if (!isUniqueConflict(error)) throw error;
      const existing = await this.database.usageEventRegistry.findFirst({
        where: { applicationId, eventId: input.event.event_id },
        select: { payloadHash: true },
      });
      if (existing === null) throw error;
      return this.itemResult(input, statusForExisting(existing, input.payloadHash));
    }
  }

  private async propertyDefinitions(
    applicationId: string,
    events: readonly unknown[],
  ): Promise<readonly PropertyDefinitionForValidation[]> {
    const hasProperties = events.some(
      (event) =>
        event !== null &&
        typeof event === "object" &&
        ("event_properties" in event || "user_properties" in event),
    );
    if (!hasProperties) return [];
    return this.database.propertyDefinition.findMany({
      where: { applicationId, status: "ACTIVE" },
      select: {
        key: true,
        scope: true,
        dataType: true,
        allowedValuesJson: true,
        constraintsJson: true,
      },
    });
  }

  private itemResult(
    input: Pick<ValidatedUsageEvent, "index" | "event">,
    status: "accepted" | "duplicate" | "conflict",
  ): UsageIngestionItemResult {
    if (status !== "conflict") {
      return { index: input.index, event_id: input.event.event_id, status };
    }
    return {
      index: input.index,
      event_id: input.event.event_id,
      status,
      code: "PAYLOAD_HASH_CONFLICT",
      message: "event_id already exists with a different canonical payload hash",
    };
  }
}

export type { UsageEvent };

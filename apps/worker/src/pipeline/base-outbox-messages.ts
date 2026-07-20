import { redactClickHouseRawPayload } from "@tokenpilot/clickhouse";
import { PropertyStatus, type Prisma } from "@tokenpilot/db";

import type { PipelineOutboxMessage, PipelineSettlementContext } from "./types.js";

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function baseOutboxMessages(
  transaction: Prisma.TransactionClient,
  context: PipelineSettlementContext,
  payloadHash: string,
): Promise<readonly PipelineOutboxMessage[]> {
  const eventId = context.event.event_id;
  const definitions = await transaction.propertyDefinition.findMany({
    where: { applicationId: context.applicationId, status: PropertyStatus.ACTIVE },
    select: { key: true, scope: true, dataType: true },
  });
  const propertyTypes = {
    event: Object.fromEntries(
      definitions
        .filter(({ scope }) => scope === "EVENT")
        .map(({ key, dataType }) => [key, dataType]),
    ),
    user: Object.fromEntries(
      definitions
        .filter(({ scope }) => scope === "USER")
        .map(({ key, dataType }) => [key, dataType]),
    ),
  };
  const applicationUser = await transaction.applicationUser.findFirstOrThrow({
    where: {
      applicationId: context.applicationId,
      externalId: context.normalized.user.user_id,
    },
  });
  const userProperties =
    applicationUser.propertiesJson !== null &&
    typeof applicationUser.propertiesJson === "object" &&
    !Array.isArray(applicationUser.propertiesJson)
      ? applicationUser.propertiesJson
      : {};
  const projectedUserProperties = Object.fromEntries(
    Object.entries(userProperties).filter(([key]) => propertyTypes.user[key] !== undefined),
  );
  return [
    {
      aggregateType: "usage_event",
      aggregateId: eventId,
      eventType: "usage_events_raw",
      payload: json({
        schema_version: "clickhouse-usage-raw",
        application_id: context.applicationId,
        // Signed credentials are live-inbox data and never enter durable projections.
        event: redactClickHouseRawPayload(context.event),
        normalized: context.normalized,
        resolution: context.resolution,
        user_tags: applicationUser.tags,
        property_types: propertyTypes,
        payload_hash: payloadHash,
      }),
      idempotencyKey: `clickhouse-raw:${eventId}:${payloadHash}`,
    },
    {
      aggregateType: "usage_event",
      aggregateId: eventId,
      eventType: "usage_lines",
      payload: json({
        schema_version: "clickhouse-usage-lines",
        application_id: context.applicationId,
        normalized: context.normalized,
        resolution: context.resolution,
        user_tags: applicationUser.tags,
        property_types: propertyTypes,
      }),
      idempotencyKey: `clickhouse-usage-lines:${eventId}:${payloadHash}`,
    },
    {
      aggregateType: "application_user",
      aggregateId: applicationUser.id,
      eventType: "application_user.profile",
      payload: json({
        schema_version: "application-user-profile-1",
        application_id: context.applicationId,
        user_record_id: applicationUser.id,
        user_id: applicationUser.externalId,
        display_user: applicationUser.name,
        tags: [...new Set(applicationUser.tags)].sort(),
        status: applicationUser.status.toLowerCase(),
        first_seen_at: applicationUser.firstSeenAt.toISOString(),
        last_seen_at: applicationUser.lastSeenAt.toISOString(),
        profile_updated_at: applicationUser.updatedAt.toISOString(),
        properties: projectedUserProperties,
        property_types: { user: propertyTypes.user },
      }),
      idempotencyKey: `clickhouse-user-profile:${eventId}:${payloadHash}`,
    },
  ];
}

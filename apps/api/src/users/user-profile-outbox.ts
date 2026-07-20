import { PropertyStatus, type DatabaseClient, type Prisma } from "@tokenpilot/db";

type UserProfileOutboxTransaction = Pick<DatabaseClient, "propertyDefinition" | "pipelineOutbox">;

interface ProjectedApplicationUser {
  readonly id: string;
  readonly applicationId: string;
  readonly externalId: string;
  readonly name: string | null;
  readonly tags: readonly string[];
  readonly propertiesJson: Prisma.JsonValue;
  readonly status: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly updatedAt: Date;
}

interface UserPropertyDefinition {
  readonly key: string;
  readonly dataType: string;
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function profilePayload(
  user: ProjectedApplicationUser,
  definitions: readonly UserPropertyDefinition[],
): Prisma.InputJsonValue {
  const properties =
    user.propertiesJson !== null &&
    typeof user.propertiesJson === "object" &&
    !Array.isArray(user.propertiesJson)
      ? (user.propertiesJson as Readonly<Record<string, Prisma.JsonValue>>)
      : {};
  const propertyTypes = Object.fromEntries(
    definitions.map((definition) => [definition.key, definition.dataType]),
  );
  const projectedProperties = Object.fromEntries(
    Object.entries(properties).filter(([key]) => propertyTypes[key] !== undefined),
  );
  return json({
    schema_version: "application-user-profile-1",
    application_id: user.applicationId,
    user_record_id: user.id,
    user_id: user.externalId,
    display_user: user.name,
    tags: [...new Set(user.tags)].sort(),
    status: user.status.toLowerCase(),
    first_seen_at: user.firstSeenAt.toISOString(),
    last_seen_at: user.lastSeenAt.toISOString(),
    profile_updated_at: user.updatedAt.toISOString(),
    properties: projectedProperties,
    property_types: { user: propertyTypes },
  });
}

async function definitions(transaction: UserProfileOutboxTransaction, applicationId: string) {
  return transaction.propertyDefinition.findMany({
    where: { applicationId, status: PropertyStatus.ACTIVE, scope: "USER" },
    select: { key: true, dataType: true },
    orderBy: { key: "asc" },
  });
}

export async function enqueueApplicationUserProfile(
  transaction: UserProfileOutboxTransaction,
  user: ProjectedApplicationUser,
  idempotencyKey: string,
): Promise<void> {
  const propertyDefinitions = await definitions(transaction, user.applicationId);
  await transaction.pipelineOutbox.create({
    data: {
      applicationId: user.applicationId,
      aggregateType: "application_user",
      aggregateId: user.id,
      eventType: "application_user.profile",
      payloadJson: profilePayload(user, propertyDefinitions),
      idempotencyKey,
    },
    select: { id: true },
  });
}

export async function enqueueApplicationUserProfiles(
  transaction: UserProfileOutboxTransaction,
  applicationId: string,
  users: readonly ProjectedApplicationUser[],
  idempotencyKey: (user: ProjectedApplicationUser) => string,
): Promise<void> {
  if (users.length === 0) return;
  const propertyDefinitions = await definitions(transaction, applicationId);
  await transaction.pipelineOutbox.createMany({
    data: users.map((user) => ({
      applicationId,
      aggregateType: "application_user",
      aggregateId: user.id,
      eventType: "application_user.profile",
      payloadJson: profilePayload(user, propertyDefinitions),
      idempotencyKey: idempotencyKey(user),
    })),
  });
}

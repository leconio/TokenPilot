import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { DatabaseClient } from "./client.js";
import { ApiKeyStatus } from "./generated/prisma/enums.js";

type ApplicationApiKeyDatabase = Pick<DatabaseClient, "applicationApiKey">;

export interface IssueApplicationApiKeyInput {
  readonly applicationId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: Date;
  readonly pepper?: string;
}

export interface IssuedApplicationApiKey {
  readonly id: string;
  readonly keyPrefix: string;
  readonly rawKey: string;
}

export interface SyncApplicationApiKeyInput {
  readonly applicationId: string;
  readonly name: string;
  readonly rawKey: string;
  readonly scopes: readonly string[];
  readonly pepper?: string;
}

export function hashApplicationApiKey(rawKey: string, pepper?: string): string {
  return pepper === undefined
    ? createHash("sha256").update(rawKey).digest("hex")
    : createHmac("sha256", pepper).update(rawKey).digest("hex");
}

export function deriveApplicationApiKeyPrefix(rawKey: string): string {
  const visiblePrefix = rawKey.slice(0, 15);
  if (/^tp_[A-Za-z0-9]{8,24}$/u.test(visiblePrefix)) return visiblePrefix;
  return `tp_${createHash("sha256").update(rawKey).digest("hex").slice(0, 12)}`;
}

export async function issueApplicationApiKey(
  database: ApplicationApiKeyDatabase,
  input: IssueApplicationApiKeyInput,
): Promise<IssuedApplicationApiKey> {
  if (input.scopes.length === 0 || input.scopes.some((scope) => scope.length === 0)) {
    throw new Error("At least one non-empty API key scope is required");
  }
  const rawKey = `tp_${randomBytes(32).toString("hex")}`;
  const keyPrefix = deriveApplicationApiKeyPrefix(rawKey);
  const record = await database.applicationApiKey.create({
    data: {
      applicationId: input.applicationId,
      name: input.name,
      keyPrefix,
      keyHash: hashApplicationApiKey(rawKey, input.pepper),
      scopes: [...input.scopes],
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    },
    select: { id: true, keyPrefix: true },
  });
  return { ...record, rawKey };
}

export async function syncApplicationApiKey(
  database: ApplicationApiKeyDatabase,
  input: SyncApplicationApiKeyInput,
): Promise<string> {
  if (input.rawKey.length < 16 || input.scopes.length === 0) {
    throw new Error("Configured API keys require at least 16 characters and one scope");
  }
  const keyHash = hashApplicationApiKey(input.rawKey, input.pepper);
  const keyPrefix = deriveApplicationApiKeyPrefix(input.rawKey);
  const record = await database.applicationApiKey.upsert({
    where: { keyHash },
    create: {
      applicationId: input.applicationId,
      name: input.name,
      keyPrefix,
      keyHash,
      scopes: [...input.scopes],
    },
    update: {
      applicationId: input.applicationId,
      name: input.name,
      scopes: [...input.scopes],
      status: ApiKeyStatus.ACTIVE,
    },
    select: { id: true },
  });
  return record.id;
}

export async function verifyApplicationApiKey(
  database: ApplicationApiKeyDatabase,
  rawKey: string,
  pepper?: string,
): Promise<{
  readonly id: string;
  readonly applicationId: string;
  readonly applicationSlug: string;
  readonly applicationStatus: "ACTIVE" | "DISABLED";
  readonly scopes: readonly string[];
} | null> {
  const keyHash = hashApplicationApiKey(rawKey, pepper);
  const record = await database.applicationApiKey.findUnique({
    where: { keyHash },
    include: { application: { select: { slug: true, status: true } } },
  });
  if (
    record === null ||
    record.status !== ApiKeyStatus.ACTIVE ||
    (record.expiresAt !== null && record.expiresAt <= new Date())
  ) {
    return null;
  }
  const expected = Buffer.from(record.keyHash, "hex");
  const actual = Buffer.from(keyHash, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  await database.applicationApiKey.update({
    where: { id: record.id },
    data: { lastUsedAt: new Date() },
  });
  return {
    id: record.id,
    applicationId: record.applicationId,
    applicationSlug: record.application.slug,
    applicationStatus: record.application.status,
    scopes: record.scopes,
  };
}

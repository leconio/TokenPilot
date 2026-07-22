import { createHash, randomBytes, randomUUID, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";

import { BadRequestException, ConflictException } from "@nestjs/common";
import { z } from "zod";

import {
  ApplicationRole,
  Prisma,
  applicationPermissionsForWrite,
  applicationSlugBase,
  issueApplicationApiKey,
  type DatabaseClient,
} from "@tokenpilot/db";

import type { ApiConfiguration } from "./api-config.js";
import { normalizeAuditIp } from "./audit-context.js";

const scrypt = promisify(scryptCallback);
const initializeSchema = z.strictObject({
  name: z.string().min(1).max(120),
  email: z.string().email().max(320),
  password: z.string().min(12).max(256),
  application_name: z.string().trim().min(1).max(120),
});
const initialAccessScopes = [
  "usage:write",
  "connector:heartbeat",
  "runtime:read",
  "runtime:write",
  "runtime:ack",
] as const;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function initializeWebSetup(
  database: DatabaseClient,
  configuration: ApiConfiguration,
  input: unknown,
  ipAddress?: string,
  userAgent?: string,
) {
  const parsed = initializeSchema.safeParse(input);
  if (!parsed.success) throw new BadRequestException("Invalid setup request");
  const value = parsed.data;
  const password = await hashPassword(value.password);
  const normalizedIp = normalizeAuditIp(ipAddress);
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);

  try {
    return await database.$transaction(
      async (transaction) => {
        if ((await transaction.user.count()) !== 0) {
          throw new ConflictException("Setup is already complete");
        }
        const user = await transaction.user.create({
          data: {
            id: randomUUID(),
            name: value.name,
            email: value.email.toLowerCase(),
            emailVerified: true,
          },
        });
        await transaction.account.create({
          data: {
            id: randomUUID(),
            accountId: user.email,
            providerId: "credential",
            userId: user.id,
            password,
          },
        });
        const application = await transaction.application.create({
          data: {
            name: value.application_name,
            slug: applicationSlugBase(value.application_name),
            timezone: configuration.timezone,
            baseCurrency: configuration.baseCurrency,
            settings: { create: {} },
            members: {
              create: {
                userId: user.id,
                role: ApplicationRole.OWNER,
                permissions: applicationPermissionsForWrite(ApplicationRole.OWNER),
              },
            },
          },
        });
        const access = await issueApplicationApiKey(transaction, {
          applicationId: application.id,
          name: "Initial application access",
          scopes: initialAccessScopes,
          pepper: configuration.apiKeyPepper,
        });
        await transaction.session.create({
          data: {
            id: randomUUID(),
            token: createHash("sha256").update(token).digest("hex"),
            userId: user.id,
            expiresAt,
            ...(ipAddress === undefined ? {} : { ipAddress }),
            ...(userAgent === undefined ? {} : { userAgent: userAgent.slice(0, 500) }),
          },
        });
        await transaction.auditLog.create({
          data: {
            actorId: `user:${user.id}`,
            action: "setup.initialize",
            objectType: "application",
            objectId: application.id,
            afterJson: { email: user.email, application_slug: application.slug },
            reason: "Initial administrator setup",
            ...(normalizedIp === undefined ? {} : { ip: normalizedIp }),
          },
        });
        await transaction.auditLog.create({
          data: {
            actorId: `user:${user.id}`,
            action: "service_api_key.create",
            objectType: "service_api_key",
            objectId: access.id,
            afterJson: {
              key_prefix: access.keyPrefix,
              name: "Initial application access",
              scopes: [...initialAccessScopes],
            },
            reason: "Initial setup application access",
            ...(normalizedIp === undefined ? {} : { ip: normalizedIp }),
          },
        });
        return {
          initialized: true,
          user: { id: user.id, name: user.name, email: user.email },
          application: { id: application.id, name: application.name, slug: application.slug },
          access_key: { id: access.id, key_prefix: access.keyPrefix, api_key: access.rawKey },
          session: { token, csrf, expiresAt },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof ConflictException) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ConflictException("Setup is already complete");
    }
    throw error;
  }
}

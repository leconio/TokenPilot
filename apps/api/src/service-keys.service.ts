import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";

import { ApiKeyStatus, issueApplicationApiKey, type DatabaseClient } from "@tokenpilot/db";

import type { ApiConfiguration } from "./api-config.js";
import { AuditService } from "./audit.service.js";
import { AuditContextService } from "./audit-context.js";
import { isApiScope, scopesUseSingleAccessPlane } from "./auth.js";
import { API_CONFIGURATION, DATABASE_CLIENT } from "./tokens.js";

const createKeySchema = z.strictObject({
  name: z.string().min(1).max(120),
  scopes: z
    .array(z.string().refine(isApiScope, "Unknown API scope"))
    .min(1)
    .max(20)
    .refine((scopes) => new Set(scopes).size === scopes.length, "Scopes must be unique")
    .refine(scopesUseSingleAccessPlane, "Machine and admin scopes require separate keys"),
  expires_at: z.string().datetime({ offset: true }).nullable().optional(),
  reason: z.string().trim().min(5).max(500),
});
const revokeKeySchema = z.strictObject({
  reason: z.string().trim().min(5).max(500),
});

@Injectable()
export class ServiceKeysService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(API_CONFIGURATION) private readonly configuration: ApiConfiguration,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AuditContextService) private readonly context: AuditContextService,
  ) {}

  private applicationId(): string {
    const id = this.context.current().applicationId;
    if (id === undefined) throw new ForbiddenException("An application context is required");
    return id;
  }

  async list(): Promise<unknown> {
    return this.database.applicationApiKey.findMany({
      where: { applicationId: this.applicationId() },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        status: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    });
  }

  async create(input: unknown) {
    const parsed = createKeySchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid Service API Key request");
    const issued = await this.database.$transaction(async (transaction) => {
      const key = await issueApplicationApiKey(transaction, {
        applicationId: this.applicationId(),
        name: parsed.data.name,
        scopes: parsed.data.scopes,
        ...(parsed.data.expires_at === undefined || parsed.data.expires_at === null
          ? {}
          : { expiresAt: new Date(parsed.data.expires_at) }),
        ...(this.configuration.apiKeyPepper === undefined
          ? {}
          : { pepper: this.configuration.apiKeyPepper }),
      });
      await this.audit.record(
        {
          action: "service_api_key.create",
          objectType: "service_api_key",
          objectId: key.id,
          after: {
            key_prefix: key.keyPrefix,
            name: parsed.data.name,
            scopes: parsed.data.scopes,
          },
          reason: parsed.data.reason,
        },
        transaction,
      );
      return key;
    });
    return { id: issued.id, key_prefix: issued.keyPrefix, api_key: issued.rawKey };
  }

  async revoke(id: string, input: unknown) {
    const parsed = revokeKeySchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException("A revocation reason is required");
    }
    return this.database.$transaction(async (transaction) => {
      const before = await transaction.applicationApiKey.findFirst({
        where: { id, applicationId: this.applicationId() },
      });
      if (before === null) throw new NotFoundException("Service API Key was not found");
      const updated = await transaction.applicationApiKey.update({
        where: { id },
        data: { status: ApiKeyStatus.REVOKED },
        select: { id: true, name: true, keyPrefix: true, scopes: true, status: true },
      });
      await this.audit.record(
        {
          action: "service_api_key.revoke",
          objectType: "service_api_key",
          objectId: id,
          before: {
            name: before.name,
            key_prefix: before.keyPrefix,
            scopes: before.scopes,
            status: before.status,
          },
          after: updated,
          reason: parsed.data.reason,
        },
        transaction,
      );
      return updated;
    });
  }
}

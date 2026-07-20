import { BadRequestException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import type { DatabaseClient } from "@tokenpilot/db";

import type { ApiConfiguration } from "./api-config.js";
import { AuditContextService } from "./audit-context.js";
import { API_CONFIGURATION, DATABASE_CLIENT } from "./tokens.js";

const auditQuery = z.strictObject({
  action: z.string().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

@Injectable()
export class WebDataService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(API_CONFIGURATION) private readonly configuration: ApiConfiguration,
    @Inject(AuditContextService) private readonly context: AuditContextService,
  ) {}

  private applicationId(): string {
    const id = this.context.current().applicationId;
    if (id === undefined) throw new ForbiddenException("An application context is required");
    return id;
  }

  async connectors() {
    const rows = await this.database.connectorInstance.findMany({
      where: { applicationId: this.applicationId() },
      orderBy: { lastHeartbeatAt: "desc" },
    });
    return {
      connectors: rows.map((row) => ({
        id: row.id,
        instance_id: row.instanceId,
        name: row.name,
        type: row.type,
        version: row.version,
        status: row.status.toLowerCase(),
        last_heartbeat_at: row.lastHeartbeatAt.toISOString(),
        buffer_depth: row.bufferDepth,
        oldest_event_age_seconds: row.oldestEventAgeSeconds?.toString() ?? null,
        metadata: row.metadataJson,
      })),
    };
  }

  async audit(input: Record<string, unknown>) {
    const parsed = auditQuery.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid audit query");
    const rows = await this.database.auditLog.findMany({
      where: {
        applicationId: this.applicationId(),
        ...(parsed.data.action === undefined ? {} : { action: parsed.data.action }),
      },
      orderBy: { createdAt: "desc" },
      take: parsed.data.limit ?? 100,
    });
    return {
      entries: rows.map((row) => ({
        id: row.id,
        actor_id: row.actorId,
        action: row.action,
        object_type: row.objectType,
        object_id: row.objectId,
        before: row.beforeJson,
        after: row.afterJson,
        reason: row.reason,
        created_at: row.createdAt.toISOString(),
      })),
    };
  }

  async settings() {
    const applicationId = this.applicationId();
    const [keys, sessions] = await Promise.all([
      this.database.applicationApiKey.count({ where: { applicationId } }),
      this.database.session.count({ where: { expiresAt: { gt: new Date() } } }),
    ]);
    const application = await this.database.application.findUniqueOrThrow({
      where: { id: applicationId },
      include: { settings: true },
    });
    return {
      app_name: application.name,
      instance_id: this.configuration.instanceId,
      timezone: application.timezone,
      base_currency: application.baseCurrency,
      raw_event_retention_days: application.settings?.rawEventRetentionDays ?? 30,
      privacy: { store_prompt_content: false, store_response_content: false },
      service_key_count: keys,
      active_web_sessions: sessions,
    };
  }
}

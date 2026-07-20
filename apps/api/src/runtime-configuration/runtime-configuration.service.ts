import { ForbiddenException, Inject, Injectable } from "@nestjs/common";

import {
  ConnectorStatus,
  PublicationStatus,
  type DatabaseClient,
  type Prisma,
} from "@tokenpilot/db";

import { AuditContextService } from "../audit-context.js";
import { AuditService } from "../audit.service.js";
import { DATABASE_CLIENT } from "../tokens.js";
import { loadRouteAudience } from "../virtual-models/route-matches.js";
import {
  buildRuntimePublication,
  runtimeVirtualModelInclude,
} from "./runtime-publication-builder.js";

@Injectable()
export class RuntimeConfigurationService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(AuditContextService) private readonly context: AuditContextService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private application() {
    const { applicationId, applicationSlug, actorId } = this.context.current();
    if (applicationId === undefined || applicationSlug === undefined) {
      throw new ForbiddenException("An application context is required");
    }
    return { id: applicationId, slug: applicationSlug, actorId };
  }

  async list() {
    const application = this.application();
    const rows = await this.database.runtimeConfigurationVersion.findMany({
      where: { applicationId: application.id },
      orderBy: { version: "desc" },
      take: 50,
      select: {
        id: true,
        version: true,
        status: true,
        etag: true,
        publishedAt: true,
        publishedBy: true,
        createdAt: true,
      },
    });
    const [acknowledgements, activeConnectors] = await Promise.all([
      this.database.runtimeConfigurationAcknowledgement.findMany({
        where: {
          applicationId: application.id,
          connectorName: "litellm",
          configurationVersion: { in: rows.map((row) => row.version) },
        },
        orderBy: [{ acknowledgedAt: "desc" }, { receivedAt: "desc" }],
        select: {
          configurationVersion: true,
          connectorInstanceId: true,
          connectorName: true,
          connectorVersion: true,
          state: true,
          acknowledgedAt: true,
          appliedAt: true,
          errorCode: true,
          errorMessage: true,
        },
      }),
      this.database.connectorInstance.findMany({
        where: {
          applicationId: application.id,
          type: "litellm",
          status: { in: [ConnectorStatus.HEALTHY, ConnectorStatus.DEGRADED] },
        },
        orderBy: { instanceId: "asc" },
        select: { instanceId: true },
      }),
    ]);
    const latest = new Map<string, (typeof acknowledgements)[number]>();
    for (const acknowledgement of acknowledgements) {
      const key = `${acknowledgement.configurationVersion}:${acknowledgement.connectorInstanceId}`;
      if (!latest.has(key)) latest.set(key, acknowledgement);
    }
    return {
      versions: rows.map((row) => {
        const connectors = activeConnectors.map((connector) => {
          const item = latest.get(`${row.version}:${connector.instanceId}`);
          return item === undefined
            ? {
                instance_id: connector.instanceId,
                name: "litellm",
                version: null,
                state: "pending" as const,
                acknowledged_at: null,
                applied_at: null,
                error: null,
              }
            : {
                instance_id: item.connectorInstanceId,
                name: item.connectorName,
                version: item.connectorVersion,
                state: item.state.toLowerCase(),
                acknowledged_at: item.acknowledgedAt.toISOString(),
                applied_at: item.appliedAt?.toISOString() ?? null,
                error:
                  item.errorCode === null || item.errorMessage === null
                    ? null
                    : { code: item.errorCode, message: item.errorMessage },
              };
        });
        const effectiveState =
          row.status !== PublicationStatus.PUBLISHED
            ? "retired"
            : connectors.some((item) => item.state === "rejected")
              ? "rejected"
              : connectors.length === 0 || connectors.some((item) => item.state === "pending")
                ? "pending"
                : connectors.every((item) => item.state === "applied")
                  ? "applied"
                  : "received";
        return {
          id: row.id,
          version: row.version,
          status: row.status,
          etag: row.etag,
          effective_state: effectiveState,
          published_at: row.publishedAt?.toISOString() ?? null,
          published_by: row.publishedBy,
          created_at: row.createdAt.toISOString(),
          connectors,
        };
      }),
    };
  }

  async publish(now: Date = new Date()) {
    const application = this.application();
    const [applicationRow, settings, properties, connections, virtualModels, latest, audience] =
      await Promise.all([
        this.database.application.findUnique({
          where: { id: application.id },
          select: { status: true },
        }),
        this.database.applicationSettings.findUnique({ where: { applicationId: application.id } }),
        this.database.propertyDefinition.findMany({
          where: { applicationId: application.id, status: "ACTIVE" },
          orderBy: { key: "asc" },
        }),
        this.database.callConnection.findMany({
          where: { applicationId: application.id, enabled: true },
          select: {
            id: true,
            name: true,
            driver: true,
            baseUrl: true,
            credentialRef: true,
            publicConfigJson: true,
          },
          orderBy: { name: "asc" },
        }),
        this.database.virtualModel.findMany({
          where: { applicationId: application.id, enabled: true },
          include: runtimeVirtualModelInclude,
          orderBy: { name: "asc" },
        }),
        this.database.runtimeConfigurationVersion.findFirst({
          where: { applicationId: application.id },
          orderBy: { version: "desc" },
          select: { version: true },
        }),
        loadRouteAudience(this.database, application.id),
      ]);
    if (applicationRow === null) throw new ForbiddenException("Application not found");
    const version = (latest?.version ?? 0) + 1;
    const { snapshot, routing } = buildRuntimePublication({
      application: {
        id: application.id,
        slug: application.slug,
        enabled: applicationRow.status === "ACTIVE",
      },
      settings,
      properties,
      connections,
      virtualModels,
      audience,
      version,
      now,
    });
    const created = await this.database.$transaction(async (transaction) => {
      await transaction.runtimeConfigurationVersion.updateMany({
        where: { applicationId: application.id, status: PublicationStatus.PUBLISHED },
        data: { status: PublicationStatus.RETIRED },
      });
      const row = await transaction.runtimeConfigurationVersion.create({
        data: {
          applicationId: application.id,
          version,
          status: PublicationStatus.PUBLISHED,
          etag: snapshot.etag,
          snapshotJson: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
          signature: snapshot.signature,
          publishedBy: application.actorId.startsWith("user:")
            ? application.actorId.slice("user:".length)
            : null,
          publishedAt: now,
        },
      });
      await transaction.virtualModel.updateMany({
        where: { applicationId: application.id, enabled: true },
        data: { lastPublishedVersion: version },
      });
      return row;
    });
    await this.audit.record({
      action: "runtime_configuration.publish",
      objectType: "runtime_configuration",
      objectId: created.id,
      after: { version, etag: snapshot.etag, virtual_models: Object.keys(routing) },
      reason: "Published application routing",
    });
    return {
      id: created.id,
      version,
      etag: snapshot.etag,
      published_at: now.toISOString(),
      virtual_model_count: Object.keys(routing).length,
    };
  }
}

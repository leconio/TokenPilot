import { BadRequestException, ForbiddenException, Inject, Injectable } from "@nestjs/common";

import {
  virtualModelRouteMatchSchema,
  type RuntimeRoute,
  type RuntimeRoutingRule,
  type RuntimeSnapshot,
} from "@tokenpilot/contracts";
import {
  ConnectorStatus,
  PublicationStatus,
  type DatabaseClient,
  type Prisma,
} from "@tokenpilot/db";

import { AuditContextService } from "../audit-context.js";
import { AuditService } from "../audit.service.js";
import { DATABASE_CLIENT } from "../tokens.js";
import { loadRouteAudience, resolveRuntimeMatch } from "../virtual-models/route-matches.js";
import {
  runtimeFingerprint,
  signRuntimeSnapshot,
  type UnsignedRuntimeSnapshot,
} from "./runtime-snapshot-integrity.js";

interface TargetRow {
  readonly id: string;
  readonly priority: number;
  readonly weight: { toNumber(): number };
  readonly model: {
    readonly id: string;
    readonly litellmTag: string;
    readonly provider: string | null;
    readonly enabled: boolean;
  };
}

function routeTarget(target: TargetRow, routeTag: string, order: number) {
  return {
    model_id: target.model.id,
    model_tag: target.model.litellmTag,
    ...(target.model.provider === null ? {} : { provider: target.model.provider }),
    route_tag: routeTag,
    fallback_order: order,
    weight: target.weight.toNumber(),
  };
}

function defaultSelectionMode(targets: readonly TargetRow[]): RuntimeRoute["selection_mode"] {
  return targets.some((target) => target.weight.toNumber() !== 1) ? "weighted" : "ordered";
}

function activeTargets(targets: readonly TargetRow[]): readonly TargetRow[] {
  return targets.filter((target) => target.model.enabled);
}

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
    const [applicationRow, settings, properties, virtualModels, latest, audience] =
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
        this.database.virtualModel.findMany({
          where: { applicationId: application.id, enabled: true },
          include: {
            application: { select: { timezone: true } },
            defaultModel: true,
            targets: {
              where: { enabled: true },
              include: { model: true },
              orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
            },
            rules: {
              where: { enabled: true },
              include: { targetModel: true },
              orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
            },
          },
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
    if (virtualModels.length === 0) {
      throw new BadRequestException("Enable at least one virtual model before publishing");
    }
    const version = (latest?.version ?? 0) + 1;
    const publishedAt = now.toISOString();
    const routing: RuntimeSnapshot["routing"] = {};
    for (const virtualModel of virtualModels) {
      const targets = activeTargets(virtualModel.targets);
      if (targets.length === 0) {
        throw new BadRequestException(`${virtualModel.displayName} has no available route`);
      }
      const defaultIndex = targets.findIndex(
        (target) => target.model.id === virtualModel.defaultModelId,
      );
      if (defaultIndex < 0) {
        throw new BadRequestException(`${virtualModel.displayName} has no available default model`);
      }
      const ordered = [
        targets[defaultIndex]!,
        ...targets.filter((_, index) => index !== defaultIndex),
      ];
      const defaultTag = `cp:virtual:${virtualModel.name}:default`;
      const defaultRoute: RuntimeRoute = {
        route_tag: defaultTag,
        selection_mode: defaultSelectionMode(ordered),
        targets: ordered.map((target, index) => routeTarget(target, defaultTag, index)),
      };
      const rules: RuntimeRoutingRule[] = [];
      const priorities = new Set<number>();
      for (const [index, rule] of virtualModel.rules.entries()) {
        if (priorities.has(rule.priority)) {
          throw new BadRequestException(
            `${virtualModel.displayName} contains route conditions with the same priority`,
          );
        }
        priorities.add(rule.priority);
        const match = virtualModelRouteMatchSchema.safeParse(rule.matchJson);
        if (!match.success) {
          throw new BadRequestException(
            `${virtualModel.displayName} contains a route condition that cannot be published`,
          );
        }
        let runtimeMatch: RuntimeRoutingRule["match"];
        try {
          runtimeMatch = resolveRuntimeMatch(match.data, audience);
        } catch {
          throw new BadRequestException(
            `${virtualModel.displayName} contains a user-group condition without a current member snapshot`,
          );
        }
        const selectedTarget = targets.find((target) => target.model.id === rule.targetModelId);
        if (selectedTarget === undefined || !rule.targetModel.enabled) {
          throw new BadRequestException(
            `${virtualModel.displayName} contains a condition for an unavailable model`,
          );
        }
        const routeTag = `cp:virtual:${virtualModel.name}:rule${index + 1}`;
        rules.push({
          id: rule.id,
          priority: rule.priority,
          match: runtimeMatch,
          route: {
            route_tag: routeTag,
            selection_mode: "ordered",
            targets: [
              selectedTarget,
              ...targets.filter((candidate) => candidate.id !== selectedTarget.id),
            ].map((candidate, order) => routeTarget(candidate, routeTag, order)),
          },
          ...(rule.expiresAt === null ? {} : { expires_at: rule.expiresAt.toISOString() }),
        });
      }
      const planIdentity = {
        application_id: application.id,
        version,
        virtual_model_id: virtualModel.id,
        default: defaultRoute,
        rules,
      };
      routing[virtualModel.name] = {
        virtual_model_id: virtualModel.id,
        configuration_version: version,
        configuration_etag: runtimeFingerprint(planIdentity),
        published_at: publishedAt,
        timezone: virtualModel.application.timezone,
        default: defaultRoute,
        rules,
      };
    }
    const base: UnsignedRuntimeSnapshot = {
      schema_version: "2.0" as const,
      application_id: application.id,
      version: `runtime-${application.slug}-${version}`,
      expires_at: new Date(now.getTime() + 10 * 365 * 86_400_000).toISOString(),
      routing,
      aiu: {
        enabled: settings?.featureAiu ?? false,
        mode: settings?.featureAiu
          ? settings.featureHardLimit
            ? "hard_limit"
            : "observe"
          : "disabled",
        unrated_model_policy: "allow_unrated" as const,
      },
      access: {
        application_enabled: applicationRow.status === "ACTIVE",
        blocked_user_ids: audience.users
          .filter((user) => user.status === "BLOCKED")
          .map((user) => user.externalId),
      },
      dimensions: {
        analytics_allowed_keys: properties.map((property) => property.key),
      },
    };
    const snapshot = signRuntimeSnapshot(base);
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

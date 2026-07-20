import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import type { RuntimeSnapshot } from "@tokenpilot/contracts";
import { PublicationStatus, type DatabaseClient, type Prisma } from "@tokenpilot/db";

import { AuditContextService } from "../audit-context.js";
import { AuditService } from "../audit.service.js";
import { DATABASE_CLIENT } from "../tokens.js";
import { loadRouteAudience } from "../virtual-models/route-matches.js";
import {
  runtimeFingerprint,
  signRuntimeSnapshot,
  verifyRuntimeSnapshot,
} from "./runtime-snapshot-integrity.js";

@Injectable()
export class RuntimeConfigurationRestoreService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(AuditContextService) private readonly context: AuditContextService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async restore(sourceVersion: number, now: Date = new Date()) {
    const { applicationId, applicationSlug, actorId } = this.context.current();
    if (applicationId === undefined || applicationSlug === undefined) {
      throw new ForbiddenException("An application context is required");
    }
    if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1) {
      throw new BadRequestException("Configuration version must be a positive integer");
    }
    const [sourceRow, latest, application, settings, properties, audience] = await Promise.all([
      this.database.runtimeConfigurationVersion.findUnique({
        where: { applicationId_version: { applicationId, version: sourceVersion } },
        select: { etag: true, signature: true, snapshotJson: true },
      }),
      this.database.runtimeConfigurationVersion.findFirst({
        where: { applicationId },
        orderBy: { version: "desc" },
        select: { version: true },
      }),
      this.database.application.findUnique({
        where: { id: applicationId },
        select: { status: true },
      }),
      this.database.applicationSettings.findUnique({ where: { applicationId } }),
      this.database.propertyDefinition.findMany({
        where: { applicationId, status: "ACTIVE" },
        orderBy: { key: "asc" },
      }),
      loadRouteAudience(this.database, applicationId),
    ]);
    if (sourceRow === null) throw new NotFoundException("Configuration version not found");
    if (application === null) throw new ForbiddenException("Application not found");
    let source: RuntimeSnapshot;
    try {
      source = verifyRuntimeSnapshot(sourceRow.snapshotJson);
    } catch {
      throw new BadRequestException("The saved configuration failed integrity checks");
    }
    if (
      source.application_id !== applicationId ||
      source.etag !== sourceRow.etag ||
      source.signature !== sourceRow.signature
    ) {
      throw new BadRequestException("The saved configuration does not belong to this application");
    }

    const modelIds = new Set<string>();
    for (const plan of Object.values(source.routing)) {
      for (const target of plan.default.targets) modelIds.add(target.model_id);
      for (const rule of plan.rules) {
        for (const target of rule.route.targets) modelIds.add(target.model_id);
      }
    }
    const availableModels = await this.database.modelDefinition.findMany({
      where: { applicationId, id: { in: [...modelIds] }, enabled: true },
      select: { id: true },
    });
    if (availableModels.length !== modelIds.size) {
      throw new BadRequestException(
        "This configuration references a model that is no longer available",
      );
    }

    const version = (latest?.version ?? 0) + 1;
    const publishedAt = now.toISOString();
    const routing: RuntimeSnapshot["routing"] = {};
    for (const [name, plan] of Object.entries(source.routing)) {
      routing[name] = {
        ...plan,
        configuration_version: version,
        configuration_etag: runtimeFingerprint({
          application_id: applicationId,
          version,
          virtual_model_id: plan.virtual_model_id,
          default: plan.default,
          rules: plan.rules,
        }),
        published_at: publishedAt,
      };
    }
    const snapshot = signRuntimeSnapshot({
      schema_version: "2.0",
      application_id: applicationId,
      version: `runtime-${applicationSlug}-${version}`,
      expires_at: new Date(now.getTime() + 10 * 365 * 86_400_000).toISOString(),
      connections: source.connections,
      routing,
      aiu: {
        enabled: settings?.featureAiu ?? false,
        mode: settings?.featureAiu
          ? settings.featureHardLimit
            ? "hard_limit"
            : "observe"
          : "disabled",
        unrated_model_policy: "allow_unrated",
      },
      access: {
        application_enabled: application.status === "ACTIVE",
        blocked_user_ids: audience.users
          .filter((user) => user.status === "BLOCKED")
          .map((user) => user.externalId),
      },
      dimensions: { analytics_allowed_keys: properties.map((property) => property.key) },
    });
    const created = await this.database.$transaction(async (transaction) => {
      await transaction.runtimeConfigurationVersion.updateMany({
        where: { applicationId, status: PublicationStatus.PUBLISHED },
        data: { status: PublicationStatus.RETIRED },
      });
      return transaction.runtimeConfigurationVersion.create({
        data: {
          applicationId,
          version,
          status: PublicationStatus.PUBLISHED,
          etag: snapshot.etag,
          snapshotJson: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
          signature: snapshot.signature,
          publishedBy: actorId.startsWith("user:") ? actorId.slice("user:".length) : null,
          publishedAt: now,
        },
      });
    });
    await this.audit.record({
      action: "runtime_configuration.restore",
      objectType: "runtime_configuration",
      objectId: created.id,
      after: { version, etag: snapshot.etag, restored_from_version: sourceVersion },
      reason: "Restored a previously published application routing configuration",
    });
    return {
      id: created.id,
      version,
      etag: snapshot.etag,
      published_at: publishedAt,
      restored_from_version: sourceVersion,
    };
  }
}

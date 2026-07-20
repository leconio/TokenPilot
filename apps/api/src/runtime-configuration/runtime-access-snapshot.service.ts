import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";

import type { RuntimeSnapshot } from "@tokenpilot/contracts";
import { PublicationStatus, type DatabaseClient, type Prisma } from "@tokenpilot/db";

import { AuditService } from "../audit.service.js";
import {
  runtimeFingerprint,
  signRuntimeSnapshot,
  verifyRuntimeSnapshot,
} from "./runtime-snapshot-integrity.js";

type RuntimeAccessDatabase = Pick<
  DatabaseClient,
  "application" | "applicationUser" | "runtimeConfigurationVersion" | "virtualModel" | "auditLog"
>;

export interface RuntimeAccessPublication {
  readonly id: string;
  readonly version: number;
  readonly etag: string;
}

/** Publishes current access controls while preserving the last published routing plan. */
@Injectable()
export class RuntimeAccessSnapshotService {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  async publishWithin(
    database: RuntimeAccessDatabase,
    input: {
      readonly applicationId: string;
      readonly actorId: string;
      readonly reason: string;
      readonly now?: Date;
    },
  ): Promise<RuntimeAccessPublication | null> {
    const current = await database.runtimeConfigurationVersion.findFirst({
      where: { applicationId: input.applicationId, status: PublicationStatus.PUBLISHED },
      orderBy: { version: "desc" },
      select: {
        applicationId: true,
        etag: true,
        signature: true,
        snapshotJson: true,
      },
    });
    if (current === null) return null;
    let source: RuntimeSnapshot;
    try {
      source = verifyRuntimeSnapshot(current.snapshotJson);
    } catch {
      throw new ServiceUnavailableException("The published configuration failed integrity checks");
    }
    if (
      current.applicationId !== input.applicationId ||
      source.application_id !== input.applicationId ||
      source.etag !== current.etag ||
      source.signature !== current.signature
    ) {
      throw new ServiceUnavailableException("The published configuration binding is invalid");
    }
    const [application, latest, blockedUsers] = await Promise.all([
      database.application.findUnique({
        where: { id: input.applicationId },
        select: { slug: true, status: true },
      }),
      database.runtimeConfigurationVersion.findFirst({
        where: { applicationId: input.applicationId },
        orderBy: { version: "desc" },
        select: { version: true },
      }),
      database.applicationUser.findMany({
        where: { applicationId: input.applicationId, status: "BLOCKED" },
        select: { externalId: true },
        orderBy: { externalId: "asc" },
        take: 50_001,
      }),
    ]);
    if (application === null) {
      throw new ServiceUnavailableException("Application access state is unavailable");
    }
    if (blockedUsers.length > 50_000) {
      throw new ServiceUnavailableException("Too many blocked users for the runtime policy");
    }
    const now = input.now ?? new Date();
    const version = (latest?.version ?? 0) + 1;
    const publishedAt = now.toISOString();
    const routing: RuntimeSnapshot["routing"] = {};
    for (const [name, plan] of Object.entries(source.routing)) {
      routing[name] = {
        ...plan,
        configuration_version: version,
        configuration_etag: runtimeFingerprint({
          application_id: input.applicationId,
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
      application_id: input.applicationId,
      version: `runtime-${application.slug}-${version}`,
      expires_at: new Date(now.getTime() + 10 * 365 * 86_400_000).toISOString(),
      routing,
      aiu: source.aiu,
      access: {
        application_enabled: application.status === "ACTIVE",
        blocked_user_ids: blockedUsers.map((user) => user.externalId),
      },
      dimensions: source.dimensions,
    });
    await database.runtimeConfigurationVersion.updateMany({
      where: { applicationId: input.applicationId, status: PublicationStatus.PUBLISHED },
      data: { status: PublicationStatus.RETIRED },
    });
    const created = await database.runtimeConfigurationVersion.create({
      data: {
        applicationId: input.applicationId,
        version,
        status: PublicationStatus.PUBLISHED,
        etag: snapshot.etag,
        snapshotJson: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
        signature: snapshot.signature,
        publishedBy: input.actorId.startsWith("user:") ? input.actorId.slice("user:".length) : null,
        publishedAt: now,
      },
      select: { id: true },
    });
    await database.virtualModel.updateMany({
      where: { applicationId: input.applicationId, enabled: true },
      data: { lastPublishedVersion: version },
    });
    await this.audit.record(
      {
        action: "runtime_configuration.access.publish",
        objectType: "runtime_configuration",
        objectId: created.id,
        applicationId: input.applicationId,
        actorId: input.actorId,
        after: {
          version,
          etag: snapshot.etag,
          application_enabled: snapshot.access.application_enabled,
          blocked_user_count: snapshot.access.blocked_user_ids.length,
        },
        reason: input.reason,
      },
      database,
    );
    return { id: created.id, version, etag: snapshot.etag };
  }
}

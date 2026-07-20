import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import {
  ApplicationRole,
  ApplicationStatus,
  createApplication,
  effectiveApplicationPermissions,
  findApplicationForUser,
  listApplicationsForUser,
  listManagedApplicationsForUser,
  type DatabaseClient,
} from "@tokenpilot/db";

import { AuditService } from "../audit.service.js";
import { WEB_SESSION_SCOPES } from "../auth.js";
import { DATABASE_CLIENT } from "../tokens.js";
import { WebAuthService } from "../web-auth.service.js";
import { RuntimeAccessSnapshotService } from "../runtime-configuration/runtime-access-snapshot.service.js";
import {
  archiveApplicationSchema,
  createApplicationSchema,
  updateApplicationSchema,
} from "./application.schemas.js";

function presentApplication(application: {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: ApplicationStatus;
  readonly timezone: string;
  readonly baseCurrency: string;
  readonly archivedAt: Date | null;
  readonly members: readonly {
    readonly role: ApplicationRole;
    readonly permissions: readonly string[];
  }[];
  readonly _count?: { readonly members: number };
}) {
  const member = application.members[0];
  return {
    id: application.id,
    name: application.name,
    slug: application.slug,
    status: application.status.toLowerCase(),
    timezone: application.timezone,
    base_currency: application.baseCurrency,
    archived_at: application.archivedAt?.toISOString() ?? null,
    role: member?.role.toLowerCase() ?? "viewer",
    permissions:
      member === undefined ? [] : effectiveApplicationPermissions(member.role, member.permissions),
    ...(application._count === undefined ? {} : { member_count: application._count.members }),
  };
}

@Injectable()
export class ApplicationService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(WebAuthService) private readonly webAuth: WebAuthService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RuntimeAccessSnapshotService)
    private readonly accessSnapshots: RuntimeAccessSnapshotService,
  ) {}

  private async userId(request: FastifyRequest): Promise<string> {
    const identity = await this.webAuth.authenticate(request.headers.cookie);
    if (identity === null) throw new UnauthorizedException("A web session is required");
    return identity.userId;
  }

  async list(request: FastifyRequest) {
    const rows = await listApplicationsForUser(this.database, await this.userId(request));
    return { applications: rows.map(presentApplication) };
  }

  async listManaged(request: FastifyRequest) {
    const rows = await listManagedApplicationsForUser(this.database, await this.userId(request));
    return { applications: rows.map(presentApplication) };
  }

  async get(request: FastifyRequest, slug: string) {
    const row = await findApplicationForUser(this.database, await this.userId(request), slug);
    if (row === null) throw new NotFoundException("Application not found");
    return presentApplication(row);
  }

  async capabilities(request: FastifyRequest, slug: string) {
    const row = await findApplicationForUser(this.database, await this.userId(request), slug);
    if (row === null) throw new NotFoundException("Application not found");
    if (row.settings === null) throw new NotFoundException("Application settings not found");
    const featureFlags = {
      usage_pipeline: row.settings.featureUsagePipeline,
      model_catalog: row.settings.featureModelCatalog,
      aiu: row.settings.featureAiu,
      quota: row.settings.featureQuota,
      hard_limit: row.settings.featureHardLimit,
      reconciliation: row.settings.featureReconciliation,
    } as const;
    const member = row.members[0];
    const role = member?.role ?? ApplicationRole.VIEWER;
    const permissions =
      member === undefined
        ? []
        : effectiveApplicationPermissions(role, member.permissions, WEB_SESSION_SCOPES);
    const capabilities = [
      ["usage", featureFlags.usage_pipeline],
      ["model_catalog", featureFlags.model_catalog],
      ["aiu", featureFlags.aiu],
      ["quota", featureFlags.quota],
      ["hard_limit", featureFlags.hard_limit],
      ["reconciliation", featureFlags.reconciliation],
    ] as const;
    return {
      feature_flags: featureFlags,
      capabilities: capabilities.flatMap(([name, enabled]) => (enabled ? [name] : [])),
      permissions,
    };
  }

  async create(request: FastifyRequest, input: unknown) {
    const parsed = createApplicationSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid application");
    const userId = await this.userId(request);
    const application = await createApplication(this.database, {
      name: parsed.data.name,
      ownerUserId: userId,
    });
    await this.audit.record({
      action: "application.create",
      objectType: "application",
      objectId: application.id,
      applicationId: application.id,
      after: { name: application.name, slug: application.slug },
      reason: "Created application",
    });
    return presentApplication({
      ...application,
      members: [
        {
          role: ApplicationRole.OWNER,
          permissions: effectiveApplicationPermissions(ApplicationRole.OWNER, WEB_SESSION_SCOPES),
        },
      ],
    });
  }

  private requireManagementPermission(application: {
    readonly members: readonly {
      readonly role: ApplicationRole;
      readonly permissions: readonly string[];
    }[];
  }): ApplicationRole {
    const member = application.members[0];
    if (
      member === undefined ||
      !effectiveApplicationPermissions(member.role, member.permissions).includes("admin:write")
    ) {
      throw new ForbiddenException("Application management permission is required");
    }
    return member.role;
  }

  async update(request: FastifyRequest, slug: string, input: unknown) {
    const parsed = updateApplicationSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid application changes");
    const userId = await this.userId(request);
    const current = await findApplicationForUser(this.database, userId, slug);
    if (current === null) throw new NotFoundException("Application not found");
    const role = this.requireManagementPermission(current);
    if (current.archivedAt !== null) {
      throw new ConflictException("An archived application is read-only");
    }
    if (parsed.data.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: parsed.data.timezone }).format();
      } catch {
        throw new BadRequestException("Invalid application timezone");
      }
    }
    const updated = await this.database.$transaction(async (transaction) => {
      const row = await transaction.application.update({
        where: { id: current.id },
        data: {
          ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
          ...(parsed.data.timezone === undefined ? {} : { timezone: parsed.data.timezone }),
          ...(parsed.data.base_currency === undefined
            ? {}
            : { baseCurrency: parsed.data.base_currency }),
          ...(parsed.data.status === undefined
            ? {}
            : {
                status:
                  parsed.data.status === "active"
                    ? ApplicationStatus.ACTIVE
                    : ApplicationStatus.DISABLED,
              }),
        },
      });
      await this.audit.record(
        {
          action: "application.update",
          objectType: "application",
          objectId: current.id,
          applicationId: current.id,
          before: {
            name: current.name,
            timezone: current.timezone,
            base_currency: current.baseCurrency,
            status: current.status.toLowerCase(),
          },
          after: {
            name: row.name,
            timezone: row.timezone,
            base_currency: row.baseCurrency,
            status: row.status.toLowerCase(),
          },
          reason: "Updated application",
        },
        transaction,
      );
      if (parsed.data.status !== undefined && row.status !== current.status) {
        await this.accessSnapshots.publishWithin(transaction, {
          applicationId: current.id,
          actorId: `user:${userId}`,
          reason:
            row.status === ApplicationStatus.ACTIVE ? "Resumed application" : "Paused application",
        });
      }
      return row;
    });
    return presentApplication({
      ...updated,
      members: [{ role, permissions: current.members[0]!.permissions }],
    });
  }

  async archive(request: FastifyRequest, slug: string, input: unknown) {
    const parsed = archiveApplicationSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid application archive request");
    const userId = await this.userId(request);
    const current = await findApplicationForUser(this.database, userId, slug);
    if (current === null) throw new NotFoundException("Application not found");
    const role = this.requireManagementPermission(current);
    if (role !== ApplicationRole.OWNER) {
      throw new ForbiddenException("Only an application owner can archive an application");
    }
    if (parsed.data.confirmation_name !== current.name) {
      throw new BadRequestException("Application name confirmation does not match");
    }
    await this.database.$transaction(async (transaction) => {
      await transaction.application.update({
        where: { id: current.id },
        data: { status: ApplicationStatus.DISABLED, archivedAt: new Date() },
      });
      await this.audit.record(
        {
          action: "application.archive",
          objectType: "application",
          objectId: current.id,
          applicationId: current.id,
          before: { status: current.status.toLowerCase() },
          after: {
            status: "disabled",
            historical_data: "retained",
            deletion_performed: false,
          },
          reason: parsed.data.reason,
        },
        transaction,
      );
      await this.accessSnapshots.publishWithin(transaction, {
        applicationId: current.id,
        actorId: `user:${userId}`,
        reason: parsed.data.reason,
      });
    });
    return {
      archived: true,
      status: "disabled",
      historical_data_retained: true,
    };
  }
}

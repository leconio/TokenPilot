import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import {
  CallConnectionDriver,
  CallConnectionStatus,
  Prisma,
  type DatabaseClient,
} from "@tokenpilot/db";

import { AuditContextService } from "../audit-context.js";
import { AuditService } from "../audit.service.js";
import { DATABASE_CLIENT } from "../tokens.js";
import { createConnectionSchema, updateConnectionSchema } from "./connection.schemas.js";

const driverToDatabase = {
  litellm: CallConnectionDriver.LITELLM,
  openai_compatible: CallConnectionDriver.OPENAI_COMPATIBLE,
  anthropic: CallConnectionDriver.ANTHROPIC,
} as const;

const driverFromDatabase = {
  [CallConnectionDriver.LITELLM]: "litellm",
  [CallConnectionDriver.OPENAI_COMPATIBLE]: "openai_compatible",
  [CallConnectionDriver.ANTHROPIC]: "anthropic",
} as const;

const statusFromDatabase = {
  [CallConnectionStatus.UNVERIFIED]: "unverified",
  [CallConnectionStatus.AVAILABLE]: "available",
  [CallConnectionStatus.DEGRADED]: "degraded",
  [CallConnectionStatus.OFFLINE]: "offline",
} as const;
const LITELLM_OFFLINE_AFTER_MS = 120_000;

function effectiveStatus(row: {
  readonly driver: CallConnectionDriver;
  readonly status: CallConnectionStatus;
  readonly lastSeenAt: Date | null;
}): (typeof statusFromDatabase)[CallConnectionStatus] {
  if (
    row.driver === CallConnectionDriver.LITELLM &&
    row.lastSeenAt !== null &&
    Date.now() - row.lastSeenAt.getTime() > LITELLM_OFFLINE_AFTER_MS
  ) {
    return "offline";
  }
  return statusFromDatabase[row.status];
}

type ConnectionRow = Prisma.CallConnectionGetPayload<{
  include: {
    connectorInstance: { select: { id: true; instanceId: true; name: true; status: true } };
    _count: { select: { models: true } };
  };
}>;

function present(row: ConnectionRow) {
  return {
    id: row.id,
    name: row.name,
    driver: driverFromDatabase[row.driver],
    base_url: row.baseUrl,
    credential_ref: row.credentialRef,
    public_config: row.publicConfigJson,
    enabled: row.enabled,
    status: effectiveStatus(row),
    last_seen_at: row.lastSeenAt?.toISOString() ?? null,
    connector_instance:
      row.connectorInstance === null
        ? null
        : {
            id: row.connectorInstance.id,
            instance_id: row.connectorInstance.instanceId,
            name: row.connectorInstance.name,
            status: row.connectorInstance.status.toLowerCase(),
          },
    model_count: row._count.models,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

const include = {
  connectorInstance: { select: { id: true, instanceId: true, name: true, status: true } },
  _count: { select: { models: true } },
} as const;

function sensitiveSubmissionReasons(value: unknown): string[] {
  const reasons = new Set<string>();
  const visit = (candidate: unknown, path: string, depth: number): void => {
    if (depth > 5 || candidate === null) return;
    if (typeof candidate === "string") {
      if (/^(?:bearer\s+|sk-|sk-ant-|AIza)/iu.test(candidate.trim())) reasons.add(path);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((child, index) => visit(child, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate)) {
      const childPath = path.length === 0 ? key : `${path}.${key}`;
      if (/(?:api[_-]?key|master[_-]?key|secret|password|access[_-]?token)/iu.test(key)) {
        reasons.add(childPath);
      } else {
        visit(child, childPath, depth + 1);
      }
    }
  };
  visit(value, "", 0);
  return [...reasons].sort();
}

@Injectable()
export class ConnectionService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(AuditContextService) private readonly context: AuditContextService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private applicationId(): string {
    const id = this.context.current().applicationId;
    if (id === undefined) throw new ForbiddenException("An application context is required");
    return id;
  }

  public async list() {
    const connections = await this.database.callConnection.findMany({
      where: { applicationId: this.applicationId() },
      include,
      orderBy: [{ enabled: "desc" }, { name: "asc" }],
    });
    return { connections: connections.map(present) };
  }

  public async get(id: string) {
    const row = await this.database.callConnection.findFirst({
      where: { id, applicationId: this.applicationId() },
      include,
    });
    if (row === null) throw new NotFoundException("Connection not found");
    return present(row);
  }

  public async create(input: unknown) {
    await this.rejectSensitiveSubmission(input);
    const parsed = createConnectionSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const value = parsed.data;
    const applicationId = this.applicationId();
    await this.ensureConnectorBinding(applicationId, value.driver, value.connector_instance_id);
    try {
      const row = await this.database.callConnection.create({
        data: {
          applicationId,
          name: value.name,
          driver: driverToDatabase[value.driver],
          baseUrl: value.base_url ?? null,
          credentialRef: value.credential_ref ?? null,
          publicConfigJson: value.public_config ?? {},
          connectorInstanceId: value.connector_instance_id ?? null,
        },
        include,
      });
      await this.audit.record({
        action: "connection.create",
        objectType: "call_connection",
        objectId: row.id,
        after: { name: row.name, driver: driverFromDatabase[row.driver] },
        reason: "Created call connection",
      });
      return present(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("A connection with this name already exists");
      }
      throw error;
    }
  }

  public async update(id: string, input: unknown) {
    await this.rejectSensitiveSubmission(input, id);
    const parsed = updateConnectionSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const applicationId = this.applicationId();
    const current = await this.database.callConnection.findFirst({
      where: { id, applicationId },
      include,
    });
    if (current === null) throw new NotFoundException("Connection not found");
    const value = parsed.data;
    const driver = value.driver ?? driverFromDatabase[current.driver];
    const complete = createConnectionSchema.safeParse({
      name: value.name ?? current.name,
      driver,
      base_url: value.base_url === undefined ? current.baseUrl : value.base_url,
      credential_ref:
        value.credential_ref === undefined ? current.credentialRef : value.credential_ref,
      public_config: value.public_config ?? (current.publicConfigJson as Record<string, unknown>),
      connector_instance_id:
        value.connector_instance_id === undefined
          ? current.connectorInstanceId
          : value.connector_instance_id,
    });
    if (!complete.success) throw new BadRequestException(complete.error.flatten());
    if (driver !== driverFromDatabase[current.driver] && current._count.models > 0) {
      throw new ConflictException(
        "Move or delete the connection's models before changing its type",
      );
    }
    await this.ensureConnectorBinding(applicationId, driver, complete.data.connector_instance_id);
    const row = await this.database.callConnection.update({
      where: { id: current.id },
      data: {
        name: complete.data.name,
        driver: driverToDatabase[complete.data.driver],
        baseUrl: complete.data.base_url ?? null,
        credentialRef: complete.data.credential_ref ?? null,
        publicConfigJson: complete.data.public_config ?? {},
        connectorInstanceId: complete.data.connector_instance_id ?? null,
        ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
      },
      include,
    });
    await this.audit.record({
      action: "connection.update",
      objectType: "call_connection",
      objectId: row.id,
      before: {
        name: current.name,
        driver: driverFromDatabase[current.driver],
        enabled: current.enabled,
      },
      after: { name: row.name, driver: driverFromDatabase[row.driver], enabled: row.enabled },
      reason: "Updated call connection",
    });
    return present(row);
  }

  public async delete(id: string) {
    const applicationId = this.applicationId();
    const current = await this.database.callConnection.findFirst({
      where: { id, applicationId },
      include,
    });
    if (current === null) throw new NotFoundException("Connection not found");
    if (current._count.models > 0) {
      throw new ConflictException("Move or delete the connection's models before deleting it");
    }
    await this.database.callConnection.delete({ where: { id: current.id } });
    await this.audit.record({
      action: "connection.delete",
      objectType: "call_connection",
      objectId: current.id,
      before: { name: current.name, driver: driverFromDatabase[current.driver] },
      reason: "Deleted call connection",
    });
    return { deleted: true };
  }

  public async check(id: string) {
    const row = await this.database.callConnection.findFirst({
      where: { id, applicationId: this.applicationId() },
      include,
    });
    if (row === null) throw new NotFoundException("Connection not found");
    if (row.driver === CallConnectionDriver.LITELLM && row.connectorInstance === null) {
      return { valid: false, status: "unverified", message: "Bind a LiteLLM connector instance" };
    }
    return {
      valid: true,
      status: effectiveStatus(row),
      message:
        row.driver === CallConnectionDriver.LITELLM
          ? "LiteLLM connector binding is valid"
          : "Connection settings are valid; credentials are checked in the application",
    };
  }

  private async ensureConnectorBinding(
    applicationId: string,
    driver: keyof typeof driverToDatabase,
    connectorInstanceId: string | null | undefined,
  ): Promise<void> {
    if (connectorInstanceId == null) return;
    if (driver !== "litellm") {
      throw new BadRequestException("Only a LiteLLM connection can bind a connector instance");
    }
    const connector = await this.database.connectorInstance.findFirst({
      where: { id: connectorInstanceId, applicationId, type: "litellm" },
      select: { id: true },
    });
    if (connector === null) throw new BadRequestException("LiteLLM connector instance not found");
  }

  private async rejectSensitiveSubmission(input: unknown, objectId?: string): Promise<void> {
    const reasons = sensitiveSubmissionReasons(input);
    if (reasons.length === 0) return;
    await this.audit.record({
      action: "connection.secret_rejected",
      objectType: "call_connection",
      objectId: objectId ?? this.applicationId(),
      after: { rejected_fields: reasons },
      reason: "Rejected a connection request containing a possible secret",
    });
    throw new BadRequestException(
      "Provider credentials must stay in the application; submit only a credential reference",
    );
  }
}

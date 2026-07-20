import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";

import { connectorHeartbeatSchema, type ConnectorHeartbeat } from "@tokenpilot/contracts";
import {
  CallConnectionStatus,
  ConnectorStatus,
  type DatabaseClient,
  type Prisma,
} from "@tokenpilot/db";

import { AuditService } from "./audit.service.js";
import { AuditContextService } from "./audit-context.js";
import { canonicalPayloadHash } from "./ingestion/canonical-payload.js";
import { DATABASE_CLIENT } from "./tokens.js";

const MAX_POSTGRES_INTEGER = 2_147_483_647;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

const statusValues = {
  healthy: ConnectorStatus.HEALTHY,
  degraded: ConnectorStatus.DEGRADED,
} as const;

const connectionStatusValues = {
  healthy: CallConnectionStatus.AVAILABLE,
  degraded: CallConnectionStatus.DEGRADED,
} as const;

export type HeartbeatRequestHeaders = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

export interface HeartbeatResponse {
  readonly status: "accepted" | "duplicate";
  readonly heartbeat_id: string;
  readonly received_at: string;
  readonly snapshot_updated: boolean;
}

interface ExistingHeartbeatReceipt {
  readonly payloadHash: string;
}

type PersistedHeartbeat =
  | { readonly outcome: "accepted"; readonly snapshotUpdated: boolean }
  | { readonly outcome: "duplicate" }
  | { readonly outcome: "conflict"; readonly existingHash: string };

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "P2002"
  );
}

function headerValue(headers: HeartbeatRequestHeaders, name: string): string | undefined {
  const value = headers[name];
  if (value === undefined || typeof value === "string") return value;
  return value.length === 1 ? value[0] : value.join(",");
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalPayloadHash(left) === canonicalPayloadHash(right);
}

function materialConfigurationChanged(
  before: {
    readonly name: string;
    readonly type: string;
    readonly version: string;
    readonly capabilitiesJson: Prisma.JsonValue | null;
  },
  heartbeat: ConnectorHeartbeat,
): boolean {
  return (
    before.name !== heartbeat.connector.name ||
    before.type !== heartbeat.connector.type ||
    before.version !== heartbeat.connector.version ||
    !sameJson(before.capabilitiesJson, heartbeat.capabilities)
  );
}

@Injectable()
export class HeartbeatService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AuditContextService) private readonly context: AuditContextService,
  ) {}

  private applicationId(): string {
    const applicationId = this.context.current().applicationId;
    if (applicationId === undefined)
      throw new BadRequestException("Application context is required");
    return applicationId;
  }

  async record(input: unknown, headers: HeartbeatRequestHeaders = {}): Promise<HeartbeatResponse> {
    const parsed = connectorHeartbeatSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Body must satisfy Connector Heartbeat");
    this.validateSemantics(parsed.data, headers);

    const receivedAt = new Date();
    const payloadHash = canonicalPayloadHash(parsed.data);
    const persisted = await this.persist(
      parsed.data,
      payloadHash,
      receivedAt,
      this.applicationId(),
    );
    if (persisted.outcome === "conflict") {
      await this.auditConflict(parsed.data, persisted.existingHash, payloadHash);
      throw new ConflictException("heartbeat_id already exists with different content");
    }
    return {
      status: persisted.outcome,
      heartbeat_id: parsed.data.heartbeat_id,
      received_at: receivedAt.toISOString(),
      snapshot_updated: persisted.outcome === "accepted" && persisted.snapshotUpdated,
    };
  }

  private validateSemantics(heartbeat: ConnectorHeartbeat, headers: HeartbeatRequestHeaders): void {
    const sentAt = new Date(heartbeat.sent_at);
    if (sentAt.getTime() > Date.now() + MAX_FUTURE_CLOCK_SKEW_MS) {
      throw new BadRequestException("sent_at is too far in the future");
    }
    if (heartbeat.buffer_depth > MAX_POSTGRES_INTEGER) {
      throw new BadRequestException(`buffer_depth cannot exceed ${MAX_POSTGRES_INTEGER}`);
    }
    if (
      (heartbeat.buffer_depth === 0 && heartbeat.oldest_event_age_seconds !== null) ||
      (heartbeat.buffer_depth > 0 && heartbeat.oldest_event_age_seconds === null)
    ) {
      throw new BadRequestException(
        "oldest_event_age_seconds must be null exactly when the durable buffer is empty",
      );
    }
    if (
      heartbeat.last_successful_upload_at !== null &&
      new Date(heartbeat.last_successful_upload_at).getTime() > sentAt.getTime()
    ) {
      throw new BadRequestException("last_successful_upload_at cannot be later than sent_at");
    }

    this.assertHeader(headers, "x-request-id", heartbeat.heartbeat_id);
    this.assertHeader(headers, "x-tokenpilot-usage-schemas", heartbeat.capabilities.usage_schema);
    this.assertHeader(headers, "x-tokenpilot-privacy-mode", "content-free");
  }

  private assertHeader(headers: HeartbeatRequestHeaders, name: string, expected: string): void {
    const actual = headerValue(headers, name);
    if (actual !== undefined && actual !== expected) {
      throw new BadRequestException(`${name} does not match the heartbeat capability payload`);
    }
  }

  private async persist(
    heartbeat: ConnectorHeartbeat,
    payloadHash: string,
    receivedAt: Date,
    applicationId: string,
  ): Promise<PersistedHeartbeat> {
    try {
      return await this.database.$transaction(async (transaction) => {
        const existingReceipt = await transaction.connectorHeartbeatReceipt.findUnique({
          where: {
            applicationId_heartbeatId: { applicationId, heartbeatId: heartbeat.heartbeat_id },
          },
          select: { payloadHash: true },
        });
        if (existingReceipt !== null) {
          return this.classifyReceipt(existingReceipt, payloadHash);
        }

        const before = await transaction.connectorInstance.findUnique({
          where: {
            applicationId_instanceId: {
              applicationId,
              instanceId: heartbeat.connector.instance_id,
            },
          },
          select: {
            name: true,
            type: true,
            version: true,
            capabilitiesJson: true,
          },
        });
        const snapshot = this.snapshotData(heartbeat, payloadHash, receivedAt);
        const connector = await transaction.connectorInstance.upsert({
          where: {
            applicationId_instanceId: {
              applicationId,
              instanceId: heartbeat.connector.instance_id,
            },
          },
          create: { applicationId, instanceId: heartbeat.connector.instance_id, ...snapshot },
          update: {},
          select: { id: true },
        });
        await transaction.connectorHeartbeatReceipt.create({
          data: {
            applicationId,
            heartbeatId: heartbeat.heartbeat_id,
            connectorInstanceId: connector.id,
            payloadHash,
            sentAt: new Date(heartbeat.sent_at),
          },
          select: { id: true },
        });
        await transaction.connectorInstance.updateMany({
          where: {
            id: connector.id,
            OR: [
              { heartbeatSentAt: null },
              { heartbeatSentAt: { lt: new Date(heartbeat.sent_at) } },
              {
                heartbeatSentAt: new Date(heartbeat.sent_at),
                OR: [
                  { lastHeartbeatId: null },
                  { lastHeartbeatId: { lt: heartbeat.heartbeat_id } },
                ],
              },
            ],
          },
          data: snapshot,
        });
        const current = await transaction.connectorInstance.findUniqueOrThrow({
          where: { id: connector.id },
          select: { lastHeartbeatId: true },
        });
        if (current.lastHeartbeatId === heartbeat.heartbeat_id) {
          await transaction.callConnection.updateMany({
            where: { applicationId, connectorInstanceId: connector.id },
            data: {
              lastSeenAt: receivedAt,
              status: connectionStatusValues[heartbeat.status],
            },
          });
        }

        if (before === null || materialConfigurationChanged(before, heartbeat)) {
          await this.audit.record(
            {
              action: before === null ? "connector.registered" : "connector.configuration.changed",
              objectType: "connector_instance",
              objectId: heartbeat.connector.instance_id,
              ...(before === null ? {} : { before }),
              after: {
                connector: heartbeat.connector,
                capabilities: heartbeat.capabilities,
                heartbeat_id: heartbeat.heartbeat_id,
              },
              reason: "Authenticated connector heartbeat",
            },
            transaction,
          );
        }
        return {
          outcome: "accepted" as const,
          snapshotUpdated: current.lastHeartbeatId === heartbeat.heartbeat_id,
        };
      });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const receipt = await this.database.connectorHeartbeatReceipt.findUnique({
        where: {
          applicationId_heartbeatId: { applicationId, heartbeatId: heartbeat.heartbeat_id },
        },
        select: { payloadHash: true },
      });
      if (receipt === null) throw error;
      return this.classifyReceipt(receipt, payloadHash);
    }
  }

  private snapshotData(
    heartbeat: ConnectorHeartbeat,
    payloadHash: string,
    receivedAt: Date,
  ): Omit<Prisma.ConnectorInstanceUncheckedCreateInput, "applicationId" | "instanceId"> {
    return {
      name: heartbeat.connector.name,
      type: heartbeat.connector.type,
      version: heartbeat.connector.version,
      status: statusValues[heartbeat.status],
      lastHeartbeatAt: receivedAt,
      heartbeatSentAt: new Date(heartbeat.sent_at),
      lastHeartbeatId: heartbeat.heartbeat_id,
      lastHeartbeatPayloadHash: payloadHash,
      lastSuccessfulUploadAt:
        heartbeat.last_successful_upload_at === null
          ? null
          : new Date(heartbeat.last_successful_upload_at),
      bufferDepth: heartbeat.buffer_depth,
      oldestEventAgeSeconds: heartbeat.oldest_event_age_seconds,
      capabilitiesJson: heartbeat.capabilities,
      metadataJson: {
        heartbeat_id: heartbeat.heartbeat_id,
        connector_sent_at: heartbeat.sent_at,
        last_successful_upload_at: heartbeat.last_successful_upload_at,
        capabilities: heartbeat.capabilities,
      },
    };
  }

  private classifyReceipt(
    receipt: ExistingHeartbeatReceipt,
    payloadHash: string,
  ): PersistedHeartbeat {
    return receipt.payloadHash === payloadHash
      ? { outcome: "duplicate" }
      : { outcome: "conflict", existingHash: receipt.payloadHash };
  }

  private async auditConflict(
    heartbeat: ConnectorHeartbeat,
    existingHash: string,
    incomingHash: string,
  ): Promise<void> {
    await this.audit.record({
      action: "connector.heartbeat.conflict",
      objectType: "connector_heartbeat",
      objectId: heartbeat.heartbeat_id,
      before: { payload_hash: existingHash },
      after: {
        payload_hash: incomingHash,
        connector_instance_id: heartbeat.connector.instance_id,
      },
      reason: "A heartbeat ID was reused with different content",
    });
  }
}

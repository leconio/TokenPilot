import { z } from "zod";

import {
  ApiKeyStatus,
  BackgroundJobStatus,
  BackgroundJobType,
  ConnectorStatus,
  Prisma,
  type DatabaseClient,
} from "@tokenpilot/db";
import type { ClickHouseClient } from "@tokenpilot/clickhouse";
import type { OperationalJobData, OperationalJobKind } from "@tokenpilot/shared";

import { countUnpricedUsage, generateUsageExport } from "./usage-export.js";

const rangeSchema = z.strictObject({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  format: z.literal("csv").optional(),
  granularity: z.enum(["hour", "day"]).optional(),
});
export interface OperationalOutcome {
  readonly kind: OperationalJobKind;
  readonly result: Readonly<Record<string, unknown>>;
}

function typeFor(kind: OperationalJobKind): BackgroundJobType {
  if (kind === "exports.generate") return BackgroundJobType.EXPORTS_GENERATE;
  return BackgroundJobType.MAINTENANCE;
}

export class OperationalProcessor {
  constructor(
    private readonly database: DatabaseClient,
    private readonly options: {
      readonly clickhouse: ClickHouseClient;
      readonly exportDirectory: string;
      readonly connectorStaleAfterSeconds: number;
    },
  ) {}

  async process(job: OperationalJobData): Promise<OperationalOutcome> {
    if (job.kind === "exports.generate" && job.applicationId === undefined) {
      throw new Error("Usage exports require an application identity");
    }
    const row = await this.ensureJob(job);
    if (
      row.status === BackgroundJobStatus.COMPLETED &&
      typeof row.resultJson === "object" &&
      row.resultJson !== null &&
      !Array.isArray(row.resultJson)
    ) {
      return { kind: job.kind, result: row.resultJson as Record<string, unknown> };
    }
    await this.database.backgroundJob.update({
      where: { id: row.id },
      data: {
        status: BackgroundJobStatus.RUNNING,
        attempts: { increment: 1 },
        startedAt: new Date(),
        completedAt: null,
        resultJson: Prisma.DbNull,
        errorCode: null,
        errorMessage: null,
      },
    });
    try {
      const result = await this.execute(job);
      await this.database.backgroundJob.update({
        where: { id: row.id },
        data: {
          status: BackgroundJobStatus.COMPLETED,
          resultJson: result as Prisma.InputJsonObject,
          completedAt: new Date(),
        },
      });
      return { kind: job.kind, result };
    } catch (error) {
      await this.database.backgroundJob.update({
        where: { id: row.id },
        data: {
          status: BackgroundJobStatus.FAILED,
          errorCode: error instanceof z.ZodError ? "INVALID_PARAMETERS" : "JOB_FAILED",
          errorMessage: error instanceof Error ? error.message.slice(0, 500) : "Unknown job error",
          completedAt: new Date(),
        },
      });
      throw error;
    }
  }

  private async ensureJob(job: OperationalJobData) {
    if (job.backgroundJobId !== undefined) {
      const row = await this.database.backgroundJob.findUniqueOrThrow({
        where: { id: job.backgroundJobId },
      });
      if (row.type !== typeFor(job.kind) || row.idempotencyKey !== job.idempotencyKey) {
        throw new Error("Operational job identity does not match its persisted background job");
      }
      if ((row.applicationId ?? undefined) !== job.applicationId) {
        throw new Error("Operational job application does not match its persisted background job");
      }
      return row;
    }
    return this.database.backgroundJob.upsert({
      where: { idempotencyKey: job.idempotencyKey },
      create: {
        ...(job.applicationId === undefined ? {} : { applicationId: job.applicationId }),
        type: typeFor(job.kind),
        idempotencyKey: job.idempotencyKey,
        parametersJson: job.parameters as Prisma.InputJsonObject,
      },
      update: {},
    });
  }

  private async execute(job: OperationalJobData): Promise<Record<string, unknown>> {
    switch (job.kind) {
      case "exports.generate":
        return this.exportUsage(job, job.parameters);
      case "connector.heartbeat.check":
        return this.checkConnectorHeartbeats();
      case "unpriced.alert":
        return this.checkUnpriced();
      case "api_key.expiry":
        return this.expireApiKeys();
    }

    throw new TypeError(`Unsupported operational job kind: ${String(job.kind)}`);
  }

  private async exportUsage(
    job: OperationalJobData,
    parameters: Readonly<Record<string, unknown>>,
  ) {
    const range = rangeSchema.parse(parameters);
    if (job.applicationId === undefined) {
      throw new Error("Usage exports require an application identity");
    }
    const result = await generateUsageExport({
      clickhouse: this.options.clickhouse,
      applicationId: job.applicationId,
      outputDirectory: this.options.exportDirectory,
      identity: job.backgroundJobId ?? job.idempotencyKey,
      from: new Date(range.from),
      to: new Date(range.to),
    });
    return {
      path: result.path,
      format: "csv",
      row_count: result.rowCount,
      bytes: result.bytes,
      content_included: false,
    };
  }

  private async checkConnectorHeartbeats() {
    const cutoff = new Date(Date.now() - this.options.connectorStaleAfterSeconds * 1000);
    const result = await this.database.connectorInstance.updateMany({
      where: { lastHeartbeatAt: { lt: cutoff }, status: { not: ConnectorStatus.STALE } },
      data: { status: ConnectorStatus.STALE },
    });
    return { stale_marked: result.count, cutoff: cutoff.toISOString() };
  }

  private async checkUnpriced() {
    const count = await countUnpricedUsage({
      clickhouse: this.options.clickhouse,
    });
    if (count > 0) {
      await this.database.auditLog.create({
        data: {
          action: "alert.unpriced",
          objectType: "current_usage_events_raw",
          objectId: "provider-cost-unpriced",
          afterJson: { count },
          reason: "Scheduled Provider Cost rating check",
        },
      });
    }
    return { unpriced_count: count, alert: count > 0 };
  }

  private async expireApiKeys() {
    const now = new Date();
    const expired = await this.database.applicationApiKey.updateMany({
      where: { status: ApiKeyStatus.ACTIVE, expiresAt: { lte: now } },
      data: { status: ApiKeyStatus.EXPIRED },
    });
    const upcoming = await this.database.applicationApiKey.count({
      where: {
        status: ApiKeyStatus.ACTIVE,
        expiresAt: { gt: now, lte: new Date(now.getTime() + 7 * 86_400_000) },
      },
    });
    if (upcoming > 0) {
      await this.database.auditLog.create({
        data: {
          action: "alert.api_key_expiring",
          objectType: "service_api_key",
          objectId: "expiring-within-7-days",
          afterJson: { count: upcoming },
          reason: "Scheduled API key expiry reminder",
        },
      });
    }
    return { expired: expired.count, expiring_within_7_days: upcoming };
  }
}

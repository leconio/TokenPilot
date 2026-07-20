import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { z } from "zod";

import { BackgroundJobStatus, BackgroundJobType } from "@tokenpilot/db";
import type { DatabaseClient, Prisma } from "@tokenpilot/db";
import { AuditContextService } from "./audit-context.js";
import { AuditService } from "./audit.service.js";
import { BackgroundJobRecoveryService } from "./background-job-recovery.service.js";
import { DATABASE_CLIENT } from "./tokens.js";

const exportSchema = z.strictObject({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  format: z.literal("csv").default("csv"),
  reason: z.string().min(1).max(500),
});

@Injectable()
export class JobsService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(BackgroundJobRecoveryService)
    private readonly recovery: BackgroundJobRecoveryService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AuditContextService) private readonly context: AuditContextService,
  ) {}

  private applicationId(): string {
    const id = this.context.current().applicationId;
    if (id === undefined) throw new ForbiddenException("An application context is required");
    return id;
  }

  async createExport(input: unknown) {
    const parsed = exportSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid export request");
    const value = parsed.data;
    if (new Date(value.from) >= new Date(value.to)) {
      throw new BadRequestException("from must precede to");
    }
    if (new Date(value.to).getTime() - new Date(value.from).getTime() > 366 * 86_400_000) {
      throw new BadRequestException("export range cannot exceed 366 days");
    }
    const applicationId = this.applicationId();
    const idempotencyKey = `export:${applicationId}:${value.from}:${value.to}:${value.format}`;
    const parameters = { from: value.from, to: value.to, format: value.format };
    const job = await this.database.$transaction(async (transaction) => {
      const created = await transaction.backgroundJob.upsert({
        where: { idempotencyKey },
        create: {
          applicationId,
          type: BackgroundJobType.EXPORTS_GENERATE,
          status: BackgroundJobStatus.QUEUED,
          idempotencyKey,
          parametersJson: parameters,
        },
        update: {},
      });
      await this.audit.record(
        {
          action: "export.create",
          objectType: "background_job",
          objectId: created.id,
          after: { idempotency_key: idempotencyKey, parameters },
          reason: value.reason,
        },
        transaction,
      );
      return created;
    });
    if (job.status === BackgroundJobStatus.QUEUED) {
      try {
        await this.recovery.enqueue(job);
      } catch {
        throw new ServiceUnavailableException(
          "Export request was stored but queueing is temporarily unavailable",
        );
      }
    }
    return this.present(job);
  }

  async find(id: string) {
    const job = await this.database.backgroundJob.findFirst({
      where: { id, applicationId: this.applicationId() },
    });
    if (job === null) throw new NotFoundException("Job not found");
    return this.present(job);
  }

  private present(job: {
    id: string;
    applicationId: string | null;
    type: BackgroundJobType;
    status: BackgroundJobStatus;
    idempotencyKey: string;
    parametersJson: Prisma.JsonValue;
    resultJson: Prisma.JsonValue | null;
    attempts: number;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: job.id,
      application_id: job.applicationId,
      type: job.type,
      status: job.status,
      idempotency_key: job.idempotencyKey,
      parameters: job.parametersJson,
      result: job.resultJson,
      attempts: job.attempts,
      error: job.errorCode === null ? null : { code: job.errorCode, message: job.errorMessage },
      created_at: job.createdAt.toISOString(),
      updated_at: job.updatedAt.toISOString(),
    };
  }
}

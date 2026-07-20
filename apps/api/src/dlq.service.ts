import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";

import {
  DeadLetterStatus,
  InboxStatus,
  PipelineStage,
  Prisma,
  type DatabaseClient,
} from "@tokenpilot/db";

import { AuditService } from "./audit.service.js";
import { AuditContextService } from "./audit-context.js";
import { DATABASE_CLIENT } from "./tokens.js";

const stageSchema = z.enum([
  "received",
  "normalized",
  "model_resolved",
  "provider_cost_rated",
  "aiu_rated",
  "quota_settled",
  "official_committed",
  "outbox_created",
  "completed",
  "dead_letter",
]);
const statusSchema = z.enum(["open", "replay_queued", "resolved", "ignored"]);
const listSchema = z.strictObject({
  stage: stageSchema.optional(),
  status: statusSchema.optional(),
  page: z.coerce.number().int().min(1).optional(),
  page_size: z.coerce.number().int().min(1).max(200).optional(),
});
const replaySchema = z.strictObject({
  dead_letter_id: z.string().uuid(),
  reason: z.string().trim().min(5).max(500),
});

type StageInput = z.infer<typeof stageSchema>;
type StatusInput = z.infer<typeof statusSchema>;

const stageValues: Readonly<Record<StageInput, PipelineStage>> = {
  received: PipelineStage.RECEIVED,
  normalized: PipelineStage.NORMALIZED,
  model_resolved: PipelineStage.MODEL_RESOLVED,
  provider_cost_rated: PipelineStage.PROVIDER_COST_RATED,
  aiu_rated: PipelineStage.AIU_RATED,
  quota_settled: PipelineStage.QUOTA_SETTLED,
  official_committed: PipelineStage.OFFICIAL_COMMITTED,
  outbox_created: PipelineStage.OUTBOX_CREATED,
  completed: PipelineStage.COMPLETED,
  dead_letter: PipelineStage.DEAD_LETTER,
};
const statusValues: Readonly<Record<StatusInput, DeadLetterStatus>> = {
  open: DeadLetterStatus.OPEN,
  replay_queued: DeadLetterStatus.REPLAY_QUEUED,
  resolved: DeadLetterStatus.RESOLVED,
  ignored: DeadLetterStatus.IGNORED,
};

function lower(value: { toString(): string }): string {
  return value.toString().toLowerCase();
}

@Injectable()
export class DlqService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AuditContextService) private readonly context: AuditContextService,
  ) {}

  public async list(input: Record<string, unknown>) {
    const parsed = listSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid DLQ query");
    const page = parsed.data.page ?? 1;
    const pageSize = parsed.data.page_size ?? 50;
    const applicationId = this.context.current().applicationId;
    if (applicationId === undefined) throw new ForbiddenException("Application context required");
    const where: Prisma.DeadLetterEventWhereInput = {
      applicationId,
      ...(parsed.data.stage === undefined ? {} : { stage: stageValues[parsed.data.stage] }),
      ...(parsed.data.status === undefined ? {} : { status: statusValues[parsed.data.status] }),
    };
    const [total, rows] = await Promise.all([
      this.database.deadLetterEvent.count({ where }),
      this.database.deadLetterEvent.findMany({
        where,
        orderBy: [{ firstFailedAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          inbox: {
            select: {
              status: true,
              payloadJson: true,
              payloadPurgedAt: true,
              eventRegistry: {
                select: { requestId: true, attemptId: true, processingStage: true },
              },
            },
          },
        },
      }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        event_id: row.eventId,
        request_id: row.inbox?.eventRegistry.requestId ?? null,
        attempt_id: row.inbox?.eventRegistry.attemptId ?? null,
        inbox_id: row.inboxId,
        outbox_id: row.outboxId?.toString() ?? null,
        stage: lower(row.stage),
        error_code: row.errorCode,
        error_class: row.errorClass,
        error_message: row.errorMessage,
        details: row.detailsJson,
        status: lower(row.status),
        attempt_count: row.attemptCount,
        replay_count: row.replayCount,
        next_retry_at: row.nextRetryAt?.toISOString() ?? null,
        first_failed_at: row.firstFailedAt.toISOString(),
        last_failed_at: row.lastFailedAt.toISOString(),
        payload_available: row.inbox?.payloadJson !== null && row.inbox !== null,
        payload_purged_at: row.inbox?.payloadPurgedAt?.toISOString() ?? null,
        resolution: row.resolution,
        resolved_at: row.resolvedAt?.toISOString() ?? null,
      })),
      page,
      page_size: pageSize,
      total,
    };
  }

  public async replay(input: unknown) {
    const parsed = replaySchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid DLQ replay request");
    const applicationId = this.context.current().applicationId;
    if (applicationId === undefined) throw new ForbiddenException("Application context required");
    const now = new Date();
    return this.database.$transaction(
      async (transaction) => {
        const locked = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT id
          FROM dead_letter_events
          WHERE id = ${parsed.data.dead_letter_id}::uuid
            AND application_id = ${applicationId}::uuid
          FOR UPDATE
        `);
        if (locked.length === 0) throw new NotFoundException("Dead-letter event was not found");
        const deadLetter = await transaction.deadLetterEvent.findFirstOrThrow({
          where: { id: parsed.data.dead_letter_id, applicationId },
          include: { inbox: true },
        });
        if (
          deadLetter.status === DeadLetterStatus.REPLAY_QUEUED &&
          deadLetter.inbox?.status === InboxStatus.PENDING
        ) {
          return {
            accepted: true,
            outcome: "idempotent",
            dead_letter_id: deadLetter.id,
            event_id: deadLetter.eventId,
          };
        }
        if (deadLetter.status !== DeadLetterStatus.OPEN) {
          throw new BadRequestException("Only open dead-letter events can be replayed");
        }
        if (deadLetter.inbox === null || deadLetter.inbox.payloadJson === null) {
          throw new BadRequestException("The canonical inbox payload is no longer available");
        }
        await transaction.deadLetterEvent.update({
          where: { id: deadLetter.id },
          data: {
            status: DeadLetterStatus.REPLAY_QUEUED,
            replayCount: { increment: 1 },
            nextRetryAt: now,
          },
        });
        await transaction.ingestionInbox.update({
          where: { id: deadLetter.inbox.id },
          data: {
            status: InboxStatus.PENDING,
            stage: PipelineStage.RECEIVED,
            attemptCount: 0,
            availableAt: now,
            nextRetryAt: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: null,
            completedAt: null,
            payloadPurgeAfter: null,
            payloadPurgedAt: null,
          },
        });
        if (deadLetter.eventId !== null) {
          await transaction.usageEventRegistry.update({
            where: {
              applicationId_eventId: {
                applicationId: deadLetter.inbox.applicationId,
                eventId: deadLetter.eventId,
              },
            },
            data: { processingStage: PipelineStage.RECEIVED, lastError: null },
          });
        }
        await this.audit.record(
          {
            action: "dead_letter.replay.queued",
            objectType: "dead_letter_event",
            objectId: deadLetter.id,
            before: { status: lower(deadLetter.status), replay_count: deadLetter.replayCount },
            after: {
              status: "replay_queued",
              replay_count: deadLetter.replayCount + 1,
              event_id: deadLetter.eventId,
            },
            reason: parsed.data.reason,
          },
          transaction,
        );
        return {
          accepted: true,
          outcome: "queued",
          dead_letter_id: deadLetter.id,
          event_id: deadLetter.eventId,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}

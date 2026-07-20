import { randomUUID } from "node:crypto";

import { Prisma, type DatabaseClient } from "@tokenpilot/db";

import { baseOutboxMessages } from "./base-outbox-messages.js";
import { RetryablePipelineError } from "./errors.js";
import { parsePipelineReplayIntent } from "./replay-intent.js";
import { PIPELINE_STAGES, type InboxLease, type PipelineStageName } from "./types.js";
import type {
  InboxOfficialCommitOutcome,
  InboxPipelineStore,
  OfficialSettlementWriter,
  PipelineFailure,
  PipelineSettlementContext,
} from "./types.js";

interface InboxLeaseRow {
  readonly id: string;
  readonly application_id: string;
  readonly event_id: string;
  readonly payload_hash: string;
  readonly payload_json: unknown;
  readonly stage: string;
  readonly attempt_count: number;
  readonly lease_owner: string;
  readonly lease_expires_at: Date;
  readonly created_at: Date;
  readonly replay_intent_json: unknown;
}

export interface PrismaInboxStoreOptions {
  readonly leaseDurationMs?: number;
  readonly payloadTtlDays?: number;
  readonly workerId?: string;
}

function stageName(value: string): PipelineStageName {
  if ((PIPELINE_STAGES as readonly string[]).includes(value)) return value as PipelineStageName;
  throw new TypeError(`Unknown persisted pipeline stage: ${value}`);
}

function mapLease(row: InboxLeaseRow): InboxLease {
  if (row.payload_json === null) {
    throw new TypeError(`Inbox ${row.id} was leased after its payload was purged`);
  }
  return {
    id: row.id,
    applicationId: row.application_id,
    eventId: row.event_id,
    payloadHash: row.payload_hash,
    payload: row.payload_json,
    stage: stageName(row.stage),
    attemptCount: row.attempt_count,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: new Date(row.lease_expires_at),
    createdAt: new Date(row.created_at),
    replayIntent: parsePipelineReplayIntent(row),
  };
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export class PrismaInboxPipelineStore implements InboxPipelineStore {
  private readonly leaseDurationMs: number;
  private readonly payloadTtlDays: number;
  private readonly workerId: string;

  constructor(
    private readonly database: DatabaseClient,
    options: PrismaInboxStoreOptions = {},
  ) {
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.payloadTtlDays = options.payloadTtlDays ?? 14;
    this.workerId = options.workerId ?? `pipeline-${process.pid}`;
    if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs < 1_000) {
      throw new RangeError("Inbox lease duration must be at least one second");
    }
    if (!Number.isSafeInteger(this.payloadTtlDays) || this.payloadTtlDays < 1) {
      throw new RangeError("Inbox payload TTL must be at least one day");
    }
  }

  async leaseInbox(limit: number): Promise<readonly InboxLease[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Inbox lease batch size must be between 1 and 1000");
    }
    const acquisitionToken = `${this.workerId}:${randomUUID()}`;
    const rows = await this.database.$transaction((transaction) =>
      transaction.$queryRawUnsafe<InboxLeaseRow[]>(
        `WITH candidates AS (
           SELECT i.id
           FROM ingestion_inbox AS i
           WHERE (
             (i.status IN ('pending', 'failed')
               AND i.available_at <= statement_timestamp()
               AND COALESCE(i.next_retry_at, i.available_at) <= statement_timestamp())
             OR (i.status = 'leased' AND i.lease_expires_at <= statement_timestamp())
           )
           AND i.stage NOT IN ('completed', 'dead_letter')
           ORDER BY i.available_at ASC, i.id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         UPDATE ingestion_inbox AS i
         SET status = 'leased',
             attempt_count = i.attempt_count + 1,
             lease_owner = $2 || ':' || i.id::text,
             lease_expires_at = statement_timestamp() + ($3 * INTERVAL '1 millisecond'),
             next_retry_at = NULL,
             last_error = NULL,
             updated_at = statement_timestamp()
         FROM candidates, usage_event_registry AS registry
         WHERE i.id = candidates.id
           AND registry.event_id = i.event_id
           AND registry.application_id = i.application_id
         RETURNING i.id, i.application_id, i.event_id, registry.payload_hash, i.payload_json, i.stage::text,
                   i.attempt_count, i.lease_owner, i.lease_expires_at, i.created_at,
                   i.replay_intent_json`,
        limit,
        acquisitionToken,
        this.leaseDurationMs,
      ),
    );
    return rows.map(mapLease);
  }

  checkpoint(lease: InboxLease, stage: PipelineStageName): Promise<InboxLease> {
    return this.database.$transaction((transaction) =>
      this.advance(transaction as unknown as Prisma.TransactionClient, lease, stage),
    );
  }

  async commitOfficial(
    lease: InboxLease,
    context: PipelineSettlementContext,
    writer: OfficialSettlementWriter,
  ): Promise<InboxOfficialCommitOutcome> {
    return this.database.$transaction(
      async (transaction) => {
        const pipelineTransaction = transaction as unknown as Prisma.TransactionClient;
        const locked = await transaction.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id
           FROM ingestion_inbox
           WHERE id = $1::uuid
             AND status = 'leased'
             AND lease_owner = $2
             AND lease_expires_at > statement_timestamp()
           FOR UPDATE`,
          lease.id,
          lease.leaseOwner,
        );
        if (locked.length !== 1) throw this.leaseLost(lease);

        const committed = await writer.commit(pipelineTransaction, context);
        let current = await this.advance(pipelineTransaction, lease, "official_committed");
        const outboxes = [
          ...(await baseOutboxMessages(pipelineTransaction, context, lease.payloadHash)),
          ...(committed.additionalOutboxMessages ?? []),
        ];
        for (const message of outboxes) {
          const existing = await transaction.pipelineOutbox.findUnique({
            where: {
              applicationId_idempotencyKey: {
                applicationId: context.applicationId,
                idempotencyKey: message.idempotencyKey,
              },
            },
            select: { id: true },
          });
          if (existing !== null) continue;
          await transaction.pipelineOutbox.create({
            data: {
              applicationId: context.applicationId,
              aggregateType: message.aggregateType,
              aggregateId: message.aggregateId,
              eventType: message.eventType,
              payloadJson: message.payload,
              idempotencyKey: message.idempotencyKey,
            },
            select: { id: true },
          });
        }
        current = await this.advance(pipelineTransaction, current, "outbox_created");
        return {
          lease: current,
          ...(committed.metrics === undefined ? {} : { metrics: committed.metrics }),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async complete(lease: InboxLease): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRawUnsafe<
        Array<{ application_id: string; event_id: string }>
      >(
        `UPDATE ingestion_inbox
         SET status = 'completed',
             stage = 'completed',
             completed_at = statement_timestamp(),
             payload_purge_after = statement_timestamp() + ($3 * INTERVAL '1 day'),
             replay_intent_json = NULL,
             updated_at = statement_timestamp()
         WHERE id = $1::uuid
           AND status = 'leased'
           AND lease_owner = $2
           AND lease_expires_at > statement_timestamp()
         RETURNING application_id, event_id`,
        lease.id,
        lease.leaseOwner,
        this.payloadTtlDays,
      );
      if (rows.length !== 1) throw this.leaseLost(lease);
      await transaction.$executeRawUnsafe(
        `UPDATE usage_event_registry
         SET processing_stage = 'completed', updated_at = statement_timestamp()
         WHERE event_id = $1 AND application_id = $2::uuid`,
        rows[0]!.event_id,
        lease.applicationId,
      );
      await transaction.$executeRawUnsafe(
        `UPDATE dead_letter_events
         SET status = 'resolved',
             resolution = 'Canonical replay completed successfully',
             resolved_at = statement_timestamp(),
             next_retry_at = NULL,
             updated_at = statement_timestamp()
         WHERE inbox_id = $1::uuid
           AND status = 'replay_queued'`,
        lease.id,
      );
    });
  }

  async retry(lease: InboxLease, error: PipelineFailure, retryAt: Date): Promise<void> {
    const changed = await this.database.$executeRawUnsafe(
      `UPDATE ingestion_inbox
       SET status = 'failed',
           available_at = $3,
           next_retry_at = $3,
           last_error = $4,
           updated_at = statement_timestamp()
       WHERE id = $1::uuid
         AND status = 'leased'
         AND lease_owner = $2
         AND lease_expires_at > statement_timestamp()`,
      lease.id,
      lease.leaseOwner,
      retryAt,
      `${error.code}: ${error.message}`,
    );
    if (changed !== 1) throw this.leaseLost(lease);
  }

  async deadLetter(lease: InboxLease, error: PipelineFailure): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        `UPDATE dead_letter_events
         SET status = 'resolved',
             resolution = 'Replay failed and was superseded by a new dead-letter event',
             resolved_at = statement_timestamp(),
             next_retry_at = NULL,
             updated_at = statement_timestamp()
         WHERE inbox_id = $1::uuid
           AND status = 'replay_queued'`,
        lease.id,
      );
      await transaction.deadLetterEvent.create({
        data: {
          applicationId: lease.applicationId,
          eventId: lease.eventId,
          inboxId: lease.id,
          stage: lease.stage.toUpperCase() as never,
          errorCode: error.code,
          errorClass: error.errorClass,
          errorMessage: error.message,
          detailsJson: json(error.details),
          attemptCount: lease.attemptCount,
        },
        select: { id: true },
      });
      const changed = await transaction.$executeRawUnsafe(
        `UPDATE ingestion_inbox
         SET status = 'dead_letter',
             stage = 'dead_letter',
             next_retry_at = NULL,
             last_error = $3,
             updated_at = statement_timestamp()
         WHERE id = $1::uuid
           AND status = 'leased'
           AND lease_owner = $2
           AND lease_expires_at > statement_timestamp()`,
        lease.id,
        lease.leaseOwner,
        `${error.code}: ${error.message}`,
      );
      if (changed !== 1) throw this.leaseLost(lease);
      await transaction.$executeRawUnsafe(
        `UPDATE usage_event_registry
         SET processing_stage = 'dead_letter', last_error = $2, updated_at = statement_timestamp()
         WHERE event_id = $1 AND application_id = $3::uuid`,
        lease.eventId,
        `${error.code}: ${error.message}`,
        lease.applicationId,
      );
    });
  }

  private async advance(
    transaction: Prisma.TransactionClient,
    lease: InboxLease,
    stage: PipelineStageName,
  ): Promise<InboxLease> {
    const rows = await transaction.$queryRawUnsafe<InboxLeaseRow[]>(
      `UPDATE ingestion_inbox AS i
       SET stage = $3::pipeline_stage,
           lease_expires_at = GREATEST(
             i.lease_expires_at + INTERVAL '1 microsecond',
             statement_timestamp() + ($4 * INTERVAL '1 millisecond')
           ),
           updated_at = statement_timestamp()
       FROM usage_event_registry AS registry
       WHERE i.id = $1::uuid
         AND i.status = 'leased'
         AND i.lease_owner = $2
         AND i.lease_expires_at > statement_timestamp()
         AND registry.event_id = i.event_id
         AND registry.application_id = i.application_id
       RETURNING i.id, i.application_id, i.event_id, registry.payload_hash, i.payload_json, i.stage::text,
                 i.attempt_count, i.lease_owner, i.lease_expires_at, i.created_at,
                 i.replay_intent_json`,
      lease.id,
      lease.leaseOwner,
      stage,
      this.leaseDurationMs,
    );
    if (rows.length !== 1) throw this.leaseLost(lease);
    await transaction.$executeRawUnsafe(
      `UPDATE usage_event_registry
       SET processing_stage = $2::pipeline_stage, updated_at = statement_timestamp()
       WHERE event_id = $1 AND application_id = $3::uuid`,
      lease.eventId,
      stage,
      lease.applicationId,
    );
    return mapLease(rows[0]!);
  }

  private leaseLost(lease: InboxLease): RetryablePipelineError {
    return new RetryablePipelineError(
      "PIPELINE_LEASE_LOST",
      `Inbox lease ${lease.id} is no longer owned by ${lease.leaseOwner}`,
      { inbox_id: lease.id, event_id: lease.eventId },
    );
  }
}

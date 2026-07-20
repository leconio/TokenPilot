import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { DeadLetterStatus, InboxStatus, PipelineStage, type DatabaseClient } from "@tokenpilot/db";

import type { AuditService } from "../src/audit.service.js";
import type { AuditContextService } from "../src/audit-context.js";
import { DlqService } from "../src/dlq.service.js";

interface RecordedAudit {
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string;
}

const deadLetterId = "075df0e0-7518-4ee5-8728-c00e9cf8eeac";
const inboxId = "175df0e0-7518-4ee5-8728-c00e9cf8eeac";
const applicationId = "00000000-0000-4000-8000-000000000001";

function appContext(): AuditContextService {
  return {
    current: () => ({ actorId: "test", applicationId, applicationSlug: "test-app" }),
  } as unknown as AuditContextService;
}

interface DeadLetterFixture {
  readonly id: string;
  readonly eventId: string;
  readonly status: DeadLetterStatus;
  readonly replayCount: number;
  readonly inbox: {
    readonly id: string;
    readonly applicationId: string;
    readonly status: InboxStatus;
    readonly payloadJson: unknown;
  };
}

function auditRecorder(records: RecordedAudit[]): AuditService {
  return {
    record: vi.fn(async (input: RecordedAudit) => {
      records.push(input);
    }),
  } as unknown as AuditService;
}

function openDeadLetter(payload: unknown = { event_id: "usage-event-1" }): DeadLetterFixture {
  return {
    id: deadLetterId,
    eventId: "usage-event-1",
    status: DeadLetterStatus.OPEN,
    replayCount: 0,
    inbox: {
      id: inboxId,
      applicationId,
      status: InboxStatus.DEAD_LETTER,
      payloadJson: payload,
    },
  };
}

function transactionDatabase(row: DeadLetterFixture) {
  const deadLetterUpdate = vi.fn();
  const inboxUpdate = vi.fn();
  const registryUpdate = vi.fn();
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: deadLetterId }]),
    deadLetterEvent: {
      findFirstOrThrow: vi.fn().mockResolvedValue(row),
      update: deadLetterUpdate,
    },
    ingestionInbox: { update: inboxUpdate },
    usageEventRegistry: { update: registryUpdate },
  };
  const database = {
    $transaction: vi.fn((callback: (value: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
  } as unknown as DatabaseClient;
  return { database, transaction, deadLetterUpdate, inboxUpdate, registryUpdate };
}

describe("canonical DLQ replay audit semantics", () => {
  it("atomically requeues the persisted inbox and records one audited command", async () => {
    const records: RecordedAudit[] = [];
    const { database, deadLetterUpdate, inboxUpdate, registryUpdate } =
      transactionDatabase(openDeadLetter());
    const service = new DlqService(database, auditRecorder(records), appContext());

    await expect(
      service.replay({
        dead_letter_id: deadLetterId,
        reason: "Retry after catalog remediation",
      }),
    ).resolves.toMatchObject({
      accepted: true,
      outcome: "queued",
      dead_letter_id: deadLetterId,
      event_id: "usage-event-1",
    });

    expect(deadLetterUpdate).toHaveBeenCalledWith({
      where: { id: deadLetterId },
      data: {
        status: DeadLetterStatus.REPLAY_QUEUED,
        replayCount: { increment: 1 },
        nextRetryAt: expect.any(Date),
      },
    });
    expect(inboxUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: inboxId },
        data: expect.objectContaining({
          status: InboxStatus.PENDING,
          stage: PipelineStage.RECEIVED,
          attemptCount: 0,
        }),
      }),
    );
    expect(registryUpdate).toHaveBeenCalledWith({
      where: {
        applicationId_eventId: {
          applicationId,
          eventId: "usage-event-1",
        },
      },
      data: { processingStage: PipelineStage.RECEIVED, lastError: null },
    });
    expect(records).toEqual([
      expect.objectContaining({
        action: "dead_letter.replay.queued",
        objectType: "dead_letter_event",
        objectId: deadLetterId,
        reason: "Retry after catalog remediation",
      }),
    ]);
  });

  it("returns an idempotent result when the same replay is already pending", async () => {
    const records: RecordedAudit[] = [];
    const row = {
      ...openDeadLetter(),
      status: DeadLetterStatus.REPLAY_QUEUED,
      inbox: { ...openDeadLetter().inbox, status: InboxStatus.PENDING },
    };
    const { database, deadLetterUpdate, inboxUpdate } = transactionDatabase(row);
    const service = new DlqService(database, auditRecorder(records), appContext());

    await expect(
      service.replay({
        dead_letter_id: deadLetterId,
        reason: "Confirm the existing replay command",
      }),
    ).resolves.toMatchObject({ accepted: true, outcome: "idempotent" });
    expect(deadLetterUpdate).not.toHaveBeenCalled();
    expect(inboxUpdate).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it("rejects replay when the TTL-governed canonical payload has been purged", async () => {
    const records: RecordedAudit[] = [];
    const { database, deadLetterUpdate, inboxUpdate } = transactionDatabase(openDeadLetter(null));
    const service = new DlqService(database, auditRecorder(records), appContext());

    const result = service.replay({
      dead_letter_id: deadLetterId,
      reason: "Retry after catalog remediation",
    });
    await expect(result).rejects.toBeInstanceOf(BadRequestException);
    await expect(result).rejects.toThrow("payload is no longer available");
    expect(deadLetterUpdate).not.toHaveBeenCalled();
    expect(inboxUpdate).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });
});

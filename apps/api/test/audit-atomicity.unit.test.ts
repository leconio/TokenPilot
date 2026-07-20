import { describe, expect, it, vi } from "vitest";

import { DeadLetterStatus, InboxStatus, type DatabaseClient } from "@tokenpilot/db";

import { AuditService } from "../src/audit.service.js";
import type { AuditContextService } from "../src/audit-context.js";
import { DlqService } from "../src/dlq.service.js";

const auditFailure = new Error("audit persistence failed");
const applicationId = "00000000-0000-4000-8000-000000000001";

function appContext(): AuditContextService {
  return {
    current: () => ({ actorId: "test", applicationId, applicationSlug: "test-app" }),
  } as unknown as AuditContextService;
}

function failingAuditWriter() {
  return { auditLog: { create: vi.fn().mockRejectedValue(auditFailure) } };
}

describe("critical mutation audit atomicity", () => {
  it("does not commit a canonical DLQ replay when audit persistence fails", async () => {
    const deadLetterId = "120251c4-5c06-4404-8178-fbc238b08f9e";
    let persisted: { deadLetter: DeadLetterStatus; inbox: InboxStatus } = {
      deadLetter: DeadLetterStatus.OPEN,
      inbox: InboxStatus.DEAD_LETTER,
    };
    const database = {
      $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => {
        const staged = { ...persisted };
        const transaction = {
          $queryRaw: vi.fn().mockResolvedValue([{ id: deadLetterId }]),
          deadLetterEvent: {
            findFirstOrThrow: vi.fn().mockResolvedValue({
              id: deadLetterId,
              eventId: "usage-event-1",
              status: DeadLetterStatus.OPEN,
              replayCount: 0,
              inbox: {
                id: "220251c4-5c06-4404-8178-fbc238b08f9e",
                applicationId,
                status: InboxStatus.DEAD_LETTER,
                payloadJson: { event_id: "usage-event-1" },
              },
            }),
            update: vi.fn(async () => {
              staged.deadLetter = DeadLetterStatus.REPLAY_QUEUED;
            }),
          },
          ingestionInbox: {
            update: vi.fn(async () => {
              staged.inbox = InboxStatus.PENDING;
            }),
          },
          usageEventRegistry: { update: vi.fn() },
          ...failingAuditWriter(),
        };
        const result = await callback(transaction);
        persisted = staged;
        return result;
      }),
    } as unknown as DatabaseClient;
    const service = new DlqService(database, new AuditService(database), appContext());

    await expect(
      service.replay({
        dead_letter_id: deadLetterId,
        reason: "retry after remediation",
      }),
    ).rejects.toThrow(auditFailure);

    expect(persisted).toEqual({
      deadLetter: DeadLetterStatus.OPEN,
      inbox: InboxStatus.DEAD_LETTER,
    });
  });
});

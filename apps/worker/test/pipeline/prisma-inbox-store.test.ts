import { describe, expect, it, vi } from "vitest";

import type { DatabaseClient } from "@tokenpilot/db";

import { PrismaInboxPipelineStore } from "../../src/pipeline/prisma-inbox-store.js";

const replayRunId = "d4f14052-7237-4e0c-8619-392140c124a4";

function row(intent: unknown) {
  return {
    id: "c8e9ba3d-3381-46d0-a382-ea5d36dcbb0b",
    application_id: "00000000-0000-4000-8000-000000000111",
    event_id: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
    payload_hash: "a".repeat(64),
    payload_json: { schema_version: "2.0" },
    stage: "received",
    attempt_count: 1,
    lease_owner: "worker:lease-1",
    lease_expires_at: new Date("2026-07-16T08:01:00.000Z"),
    created_at: new Date("2026-07-16T08:00:00.000Z"),
    replay_intent_json: intent,
  };
}

function store(persistedRow: ReturnType<typeof row>) {
  const query = vi.fn().mockResolvedValue([persistedRow]);
  const transaction = { $queryRawUnsafe: query };
  const database = {
    $transaction: vi.fn(async (operation: (value: typeof transaction) => unknown) =>
      operation(transaction),
    ),
  } as unknown as DatabaseClient;
  return new PrismaInboxPipelineStore(database, { workerId: "test-worker" });
}

describe("PrismaInboxPipelineStore replay intent", () => {
  it("keeps an ordinary inbox lease free of replay state", async () => {
    await expect(store(row(null)).leaseInbox(1)).resolves.toEqual([
      expect.objectContaining({ replayIntent: null }),
    ]);
  });

  it.each([
    ["rerun_provider_cost", "rerate", "keep_unrated"],
    ["rerun_aiu_observe", "keep_existing", "backfill"],
  ] as const)("maps reconciliation action %s", async (replayType, providerCost, aiu) => {
    const current = store(
      row({
        authority: "reconciliation",
        run_id: replayRunId,
        replay_type: replayType,
      }),
    );

    await expect(current.leaseInbox(1)).resolves.toEqual([
      expect.objectContaining({
        replayIntent: {
          runId: replayRunId,
          authority: "reconciliation",
          providerCost,
          aiu,
          quota: "keep_existing",
        },
      }),
    ]);
  });

  it.each([
    { authority: "reconciliation", run_id: "not-a-uuid", replay_type: "rerun_aiu_observe" },
    { authority: "reconciliation", run_id: replayRunId, replay_type: "unsupported" },
    {
      authority: "reconciliation",
      run_id: replayRunId,
      replay_type: "rerun_aiu_observe",
      extra: true,
    },
    { provider_cost: "rerate", aiu: "backfill" },
  ])("rejects malformed or obsolete replay intent %#", async (intent) => {
    await expect(store(row(intent)).leaseInbox(1)).rejects.toThrow(/replay intent/u);
  });
});

import { describe, expect, it, vi } from "vitest";

import type { DatabaseClient, Prisma } from "@tokenpilot/db";
import { planReplay, type ReplayType } from "@tokenpilot/reconciliation-engine";

import {
  PrismaReconciliationOperationExecutor,
  type ClickHouseRebuildExecutor,
} from "../../src/reconciliation/operation-executor.js";

const runId = "d4f14052-7237-4e0c-8619-392140c124a4";
const rangeStart = "2026-07-16T00:00:00.000Z";
const rangeEnd = "2026-07-16T01:00:00.000Z";

function committedPlan(replayType: ReplayType) {
  return planReplay({
    replayType,
    rangeStart,
    rangeEnd,
    dryRun: false,
    reason: "repair the audited projection",
    requestedBy: "operator-1",
  });
}

function harness(replayType: ReplayType, affectedRecords: number) {
  const plan = committedPlan(replayType);
  const executeRaw = vi.fn().mockResolvedValue(affectedRecords);
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const findUniqueOrThrow = vi.fn().mockResolvedValue({
    scopeJson: {
      operation: "replay",
      plan,
      source_diff_id: "diff-1",
      reason: "repair the audited projection",
    },
  });
  const update = vi.fn().mockResolvedValue({ id: runId });
  const transaction = {
    reconciliationRun: { updateMany, findUniqueOrThrow },
  };
  const database = {
    $executeRaw: executeRaw,
    $transaction: vi.fn(async (operation: (value: typeof transaction) => unknown) =>
      operation(transaction),
    ),
    reconciliationRun: { update },
  } as unknown as DatabaseClient;
  const clickhouseRebuild = {
    execute: vi.fn(),
  } as unknown as ClickHouseRebuildExecutor;
  return {
    executeRaw,
    executor: new PrismaReconciliationOperationExecutor(database, clickhouseRebuild),
  };
}

function statement(call: readonly unknown[] | undefined): Prisma.Sql {
  const value = call?.[0];
  if (value === undefined) throw new TypeError("Expected a raw SQL statement");
  return value as Prisma.Sql;
}

describe("PrismaReconciliationOperationExecutor replay", () => {
  it.each(["reproject_to_clickhouse"] as const)(
    "clones terminal canonical outbox rows for %s without reopening them",
    async (replayType) => {
      const { executeRaw, executor } = harness(replayType, 3);

      await expect(executor.executeReplay(runId)).resolves.toEqual({
        replay_type: replayType,
        outbox_records_requeued: 3,
      });

      const sql = statement(executeRaw.mock.calls[0]);
      const query = sql.strings.join("?");
      expect(query).toContain("INSERT INTO pipeline_outbox");
      expect(query).toContain(
        "SELECT outbox.application_id, outbox.aggregate_type, outbox.aggregate_id, outbox.event_type",
      );
      expect(query).toContain("outbox.payload_json, 'pending'");
      expect(query).toContain("COALESCE(outbox.replay_of_outbox_id, outbox.id)");
      expect(query).toContain("outbox.status IN ('sent', 'dead_letter')");
      expect(query).toContain("outbox.idempotency_key NOT LIKE 'reconciliation:%'");
      expect(query).toContain("'application_user.profile'");
      expect(query).toContain("outbox.payload_json->>'profile_updated_at'");
      expect(query).toContain("ON CONFLICT (application_id, idempotency_key) DO NOTHING");
      expect(query).not.toContain("UPDATE pipeline_outbox");
      expect(sql.values).toContain(`reconciliation:${runId}:outbox:`);
      expect(sql.values).toContainEqual(new Date(rangeStart));
      expect(sql.values).toContainEqual(new Date(rangeEnd));
    },
  );

  it.each(["rerun_provider_cost", "rerun_aiu_observe"] as const)(
    "resets the unique inbox with an audited %s intent",
    async (replayType) => {
      const { executeRaw, executor } = harness(replayType, 2);

      await expect(executor.executeReplay(runId)).resolves.toEqual({
        replay_type: replayType,
        inbox_records_requeued: 2,
      });

      const sql = statement(executeRaw.mock.calls[0]);
      const query = sql.strings.join("?");
      expect(query).toContain("UPDATE ingestion_inbox AS inbox");
      expect(query).toContain("attempt_count = 0");
      expect(query).toContain("lease_owner = NULL, lease_expires_at = NULL, last_error = NULL");
      expect(query).toContain("completed_at = NULL");
      expect(query).toContain("payload_purge_after = NULL, payload_purged_at = NULL");
      expect(query).toContain("'authority', 'reconciliation'");
      expect(query).toContain("'run_id', ?");
      expect(query).toContain("'replay_type', ?");
      expect(query).not.toContain("replay_run_id");
      expect(query).toContain("inbox.status IN ('pending', 'failed', 'completed', 'dead_letter')");
      expect(sql.values).toContain(runId);
      expect(sql.values).toContain(replayType);
      expect(sql.values).toContainEqual(new Date(rangeStart));
      expect(sql.values).toContainEqual(new Date(rangeEnd));
    },
  );
});

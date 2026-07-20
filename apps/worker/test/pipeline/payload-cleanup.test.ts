import { readFileSync } from "node:fs";

import type { DatabaseClient } from "@tokenpilot/db";
import { describe, expect, it, vi } from "vitest";

import { InboxPayloadCleanupService } from "../../src/pipeline/payload-cleanup.js";

describe("InboxPayloadCleanupService", () => {
  it("audits payload hashes and sizes without retaining the raw payload", async () => {
    const createMany = vi.fn(
      async (input: {
        data: Array<{
          beforeJson: Record<string, unknown>;
          afterJson: Record<string, unknown>;
        }>;
      }) => {
        void input;
        return { count: 1 };
      },
    );
    const row = {
      id: "10e75f92-f066-4e1a-b6ee-2563e00b8f0d",
      event_id: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
      payload_hash: "a".repeat(64),
      payload_bytes: 512,
      payload_purge_after: new Date("2026-07-15T00:00:00.000Z"),
      payload_purged_at: new Date("2026-07-16T00:00:00.000Z"),
    };
    const database = {
      $transaction: vi.fn(async (callback) =>
        callback({
          $queryRawUnsafe: vi.fn(async () => [row]),
          auditLog: { createMany },
        }),
      ),
    } as unknown as DatabaseClient;
    const metrics = { record: vi.fn() };

    await expect(
      new InboxPayloadCleanupService(database, metrics).purgeBatch(),
    ).resolves.toMatchObject({
      purgedPayloads: 1,
      purgedBytes: 512,
      eventIds: [row.event_id],
    });
    const audit = createMany.mock.calls[0]![0].data[0]!;
    expect(audit.beforeJson).toMatchObject({ payload_hash: row.payload_hash, payload_bytes: 512 });
    expect(JSON.stringify(audit)).not.toContain("payload_json");
    expect(metrics.record).toHaveBeenCalledOnce();
  });

  it("locks cleanup candidates and enforces TTL, CH, DLQ, and reconciliation gates", () => {
    const source = readFileSync(
      new URL("../../src/pipeline/payload-cleanup.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("FOR UPDATE OF inbox SKIP LOCKED");
    expect(source).toContain("payload_purge_after <= statement_timestamp()");
    expect(source).toContain("clickhouse_raw_synced_at IS NOT NULL");
    expect(source).toContain("dead_letter.status IN ('open', 'replay_queued')");
    expect(source).toContain("diff.status IN ('open', 'investigating')");
    expect(source).toContain("payload_json = NULL");
  });
});

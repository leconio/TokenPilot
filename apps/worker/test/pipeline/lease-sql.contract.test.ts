import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("pipeline lease SQL contracts", () => {
  it("uses SKIP LOCKED, expiring takeover tokens, and owner fencing for inbox and outbox", () => {
    for (const source of [
      readFileSync(new URL("../../src/pipeline/prisma-inbox-store.ts", import.meta.url), "utf8"),
      readFileSync(new URL("../../src/pipeline/prisma-outbox-store.ts", import.meta.url), "utf8"),
    ]) {
      expect(source).toContain("FOR UPDATE SKIP LOCKED");
      expect(source).toContain("lease_expires_at <= statement_timestamp()");
      expect(source).toContain("attempt_count =");
      expect(source).toContain("lease_owner =");
      expect(source).toContain("lease_expires_at > statement_timestamp()");
    }
  });

  it("keeps the PostgreSQL ClickHouse cursor monotonic across reverse Worker completion", () => {
    const source = readFileSync(
      new URL("../../src/pipeline/prisma-outbox-store.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("ON CONFLICT (pipeline_name) DO UPDATE SET");
    expect(source).toContain("EXCLUDED.last_outbox_id >= clickhouse_sync_state.last_outbox_id");
    expect(source).toContain("ELSE clickhouse_sync_state.last_outbox_id");
    expect(source).toContain("ELSE clickhouse_sync_state.last_event_time");
    expect(source).toContain("ELSE clickhouse_sync_state.lag_seconds");
  });
});

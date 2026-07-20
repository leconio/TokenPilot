import type { ClickHouseClient } from "@clickhouse/client";
import { describe, expect, it, vi } from "vitest";

import {
  checkClickHouseSinkReadiness,
  ClickHouseSinkNotReadyError,
  requireClickHouseSinkReadiness,
  type ClickHouseMigration,
} from "../src/index.js";

const migration: ClickHouseMigration = {
  version: 1,
  name: "schema",
  fileName: "0001_schema.sql",
  absolutePath: "/migrations/0001_schema.sql",
  checksum: "a".repeat(64),
  sql: "CREATE TABLE IF NOT EXISTS probe (id UInt8) ENGINE = Memory",
};

function json(rows: readonly unknown[]) {
  return { json: vi.fn().mockResolvedValue(rows) };
}

describe("ClickHouse sink readiness isolation", () => {
  it("requires authenticated health and fully verified migrations", async () => {
    const query = vi.fn(async ({ query: sql }: { query: string }) => {
      if (sql.includes("version()")) {
        return json([{ version: "26.3.17.4", database: "ai_control_plane" }]);
      }
      if (sql.includes("system.tables")) {
        return json([
          { name: "clickhouse_schema_migrations", engine: "MergeTree" },
          { name: "probe", engine: "Memory" },
        ]);
      }
      return json([
        {
          version: 1,
          name: "schema",
          checksum: migration.checksum,
          applied_at_text: "2026-07-16 00:00:00.000",
          application_count: "1",
        },
      ]);
    });
    const client = { query } as unknown as ClickHouseClient;

    await expect(
      requireClickHouseSinkReadiness(client, "ai_control_plane", [migration]),
    ).resolves.toMatchObject({ ready: true });
  });

  it("reports degradation without throwing outside sink startup", async () => {
    const client = {
      query: vi.fn().mockRejectedValue(new Error("ClickHouse unavailable")),
    } as unknown as ClickHouseClient;

    await expect(
      checkClickHouseSinkReadiness(client, "ai_control_plane", [migration]),
    ).resolves.toMatchObject({
      ready: false,
      errorClass: "ClickHouseHealthError",
    });
    await expect(
      requireClickHouseSinkReadiness(client, "ai_control_plane", [migration]),
    ).rejects.toBeInstanceOf(ClickHouseSinkNotReadyError);
  });
});

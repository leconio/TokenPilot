import type { ClickHouseClient } from "@clickhouse/client";

import { sanitizeClickHouseError } from "./errors.js";

interface HealthRow {
  readonly version: string;
  readonly database: string;
}

export type ClickHouseHealthResult =
  | {
      readonly ok: true;
      readonly version: string;
      readonly database: string;
      readonly durationMs: number;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly durationMs: number;
    };

export async function checkClickHouseHealth(
  client: ClickHouseClient,
): Promise<ClickHouseHealthResult> {
  const startedAt = performance.now();
  try {
    const result = await client.query({
      query: "SELECT version() AS version, currentDatabase() AS database",
      format: "JSONEachRow",
      clickhouse_settings: { readonly: "1" },
    });
    const rows = await result.json<HealthRow>();
    const row = rows[0];
    if (row === undefined || row.version === "" || row.database === "") {
      throw new Error("ClickHouse health query returned no row");
    }
    return {
      ok: true,
      version: row.version,
      database: row.database,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  } catch (error) {
    return {
      ok: false,
      error: sanitizeClickHouseError(error),
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  }
}

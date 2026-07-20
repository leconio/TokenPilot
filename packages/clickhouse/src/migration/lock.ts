import { randomUUID } from "node:crypto";

import type { ClickHouseClient } from "@clickhouse/client";

import {
  ClickHouseMigrationError,
  ClickHouseMigrationLockError,
  sanitizeClickHouseError,
} from "../errors.js";
import { MIGRATION_LOCK_TABLE, qualifyClickHouseTable } from "./constants.js";

interface ErrorWithCode {
  readonly code?: unknown;
}

export async function acquireMigrationLock(
  client: ClickHouseClient,
  database: string,
): Promise<void> {
  const table = qualifyClickHouseTable(database, MIGRATION_LOCK_TABLE);
  try {
    await client.command({
      query: `CREATE TABLE ${table} (acquired_at DateTime64(3, 'UTC') DEFAULT now64(3)) ENGINE = Memory`,
      query_id: `ai_control_clickhouse_lock_${randomUUID()}`,
    });
  } catch (error) {
    if (String((error as ErrorWithCode | null)?.code) === "57") {
      throw new ClickHouseMigrationLockError(
        "Another ClickHouse migration runner holds the schema lock; after a crashed runner is stopped, an operator must verify and drop the lock table",
        { cause: error },
      );
    }
    throw new ClickHouseMigrationError(
      `Unable to acquire the ClickHouse migration lock: ${sanitizeClickHouseError(error)}`,
      { cause: error },
    );
  }
}

export async function releaseMigrationLock(
  client: ClickHouseClient,
  database: string,
): Promise<void> {
  await client.command({
    query: `DROP TABLE IF EXISTS ${qualifyClickHouseTable(database, MIGRATION_LOCK_TABLE)}`,
    query_id: `ai_control_clickhouse_unlock_${randomUUID()}`,
  });
}

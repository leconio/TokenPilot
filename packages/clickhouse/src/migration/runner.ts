import { randomUUID } from "node:crypto";

import type { ClickHouseClient } from "@clickhouse/client";

import { ClickHouseMigrationError, sanitizeClickHouseError } from "../errors.js";
import { checkClickHouseHealth } from "../health.js";
import { MIGRATIONS_TABLE, qualifyClickHouseTable } from "./constants.js";
import { ensureMigrationsTable, getClickHouseMigrationStatus } from "./history.js";
import { acquireMigrationLock, releaseMigrationLock } from "./lock.js";
import type {
  ClickHouseMigration,
  ClickHouseMigrationStatusReport,
  ClickHouseMigrationUpResult,
} from "./types.js";

export async function applyClickHouseMigrations(
  client: ClickHouseClient,
  database: string,
  migrations: readonly ClickHouseMigration[],
): Promise<ClickHouseMigrationUpResult> {
  const health = await checkClickHouseHealth(client);
  if (!health.ok) {
    throw new ClickHouseMigrationError(`ClickHouse health check failed: ${health.error}`);
  }

  let lockAcquired = false;
  let installationStarted = false;
  let primaryError: ClickHouseMigrationError | undefined;
  let result: ClickHouseMigrationUpResult | undefined;
  try {
    await acquireMigrationLock(client, database);
    lockAcquired = true;
    let report = await getClickHouseMigrationStatus(client, database, migrations);
    if (report.installationState === "installed") {
      result = { appliedVersions: [], status: report };
    } else if (report.installationState !== "empty") {
      throw freshDatabaseRequired(database, report);
    } else {
      installationStarted = true;
      await ensureMigrationsTable(client, database);
      const appliedVersions: number[] = [];
      const historyTable = qualifyClickHouseTable(database, MIGRATIONS_TABLE);

      for (const migration of migrations) {
        const startedAt = performance.now();
        await client.command({
          query: migration.sql,
          query_id: `ai_control_clickhouse_migration_${migration.version}_${randomUUID()}`,
        });
        await client.insert({
          table: historyTable,
          query_id: `ai_control_clickhouse_migration_history_${migration.version}_${randomUUID()}`,
          values: [
            {
              version: migration.version,
              name: migration.name,
              checksum: migration.checksum,
              execution_ms: Math.max(0, Math.round(performance.now() - startedAt)),
            },
          ],
          format: "JSONEachRow",
          clickhouse_settings: { async_insert: 0, wait_for_async_insert: 1 },
        });
        appliedVersions.push(migration.version);
      }
      report = await getClickHouseMigrationStatus(client, database, migrations);
      if (report.installationState !== "installed") {
        throw freshDatabaseRequired(database, report);
      }
      result = { appliedVersions, status: report };
    }
  } catch (error) {
    primaryError =
      error instanceof ClickHouseMigrationError
        ? error
        : new ClickHouseMigrationError(
            `ClickHouse migration failed: ${sanitizeClickHouseError(error)}`,
            { cause: error },
          );
    if (installationStarted && !primaryError.message.includes("delete and recreate")) {
      primaryError.message = `${primaryError.message}. The current baseline installation is incomplete; delete and recreate ClickHouse database '${database}' before retrying`;
    }
  }

  let unlockError: unknown;
  if (lockAcquired) {
    try {
      await releaseMigrationLock(client, database);
    } catch (error) {
      unlockError = error;
    }
  }
  if (primaryError !== undefined) {
    if (unlockError !== undefined) {
      primaryError.message = `${primaryError.message}; additionally failed to release the ClickHouse migration lock: ${sanitizeClickHouseError(unlockError)}`;
    }
    throw primaryError;
  }
  if (unlockError !== undefined) {
    throw new ClickHouseMigrationError(
      `ClickHouse migration completed but failed to release the ClickHouse migration lock: ${sanitizeClickHouseError(unlockError)}`,
      { cause: unlockError },
    );
  }
  if (result === undefined)
    throw new ClickHouseMigrationError("ClickHouse migration produced no result");
  return result;
}

export async function verifyClickHouseMigrations(
  client: ClickHouseClient,
  database: string,
  migrations: readonly ClickHouseMigration[],
): Promise<ClickHouseMigrationStatusReport> {
  const report = await getClickHouseMigrationStatus(client, database, migrations);
  if (report.installationState === "empty") {
    throw new ClickHouseMigrationError(
      `ClickHouse current baseline is not installed in empty database '${database}'; run the ClickHouse baseline installer`,
    );
  }
  if (report.installationState !== "installed") {
    throw freshDatabaseRequired(database, report);
  }
  return report;
}

function freshDatabaseRequired(
  database: string,
  report: ClickHouseMigrationStatusReport,
): ClickHouseMigrationError {
  const history = report.migrations
    .filter((migration) => migration.state !== "applied")
    .map((migration) => `${migration.version}:${migration.state}`);
  const details = [
    history.length > 0 ? `history=${history.join(",")}` : undefined,
    report.missingObjects.length > 0 ? `missing=${report.missingObjects.join(",")}` : undefined,
    report.unexpectedObjects.length > 0
      ? `unexpected=${report.unexpectedObjects.join(",")}`
      : undefined,
    report.conflictingObjects.length > 0
      ? `conflicting=${report.conflictingObjects
          .map((object) => `${object.name}:${object.actualEngine}->${object.expectedEngine}`)
          .join(",")}`
      : undefined,
    report.migrationTableExists && !report.migrationTableReadable
      ? "history_table=unreadable"
      : undefined,
  ].filter((detail): detail is string => detail !== undefined);
  return new ClickHouseMigrationError(
    `ClickHouse database '${database}' contains a partial, conflicting, or old schema (${details.join("; ") || "unknown conflict"}); delete and recreate the database, then install the current baseline`,
  );
}

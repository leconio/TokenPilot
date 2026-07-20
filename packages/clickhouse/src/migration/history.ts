import { randomUUID } from "node:crypto";

import type { ClickHouseClient } from "@clickhouse/client";

import { assertClickHouseIdentifier } from "../config.js";
import { MIGRATION_LOCK_TABLE, MIGRATIONS_TABLE, qualifyClickHouseTable } from "./constants.js";
import { assertClickHouseMigrationSequence, getClickHouseBaselineObjects } from "./discovery.js";
import type {
  ClickHouseMigration,
  ClickHouseMigrationStatus,
  ClickHouseMigrationStatusReport,
} from "./types.js";

interface SchemaObjectRow {
  readonly name: string;
  readonly engine: string;
}

interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at_text: string;
  readonly application_count: string;
}

async function readSchemaObjects(
  client: ClickHouseClient,
  database: string,
): Promise<readonly SchemaObjectRow[]> {
  const result = await client.query({
    query:
      "SELECT name, engine FROM system.tables WHERE database = {database:String} ORDER BY name",
    query_params: { database },
    format: "JSONEachRow",
    clickhouse_settings: { readonly: "1" },
  });
  return result.json<SchemaObjectRow>();
}

async function readAppliedMigrations(
  client: ClickHouseClient,
  database: string,
): Promise<readonly AppliedMigrationRow[]> {
  const table = qualifyClickHouseTable(database, MIGRATIONS_TABLE);
  const result = await client.query({
    query: `SELECT version, argMax(name, applied_at) AS name, argMax(checksum, applied_at) AS checksum, toString(max(applied_at)) AS applied_at_text, toString(count()) AS application_count FROM ${table} GROUP BY version ORDER BY version`,
    format: "JSONEachRow",
    clickhouse_settings: { readonly: "1" },
  });
  return result.json<AppliedMigrationRow>();
}

export async function ensureMigrationsTable(
  client: ClickHouseClient,
  database: string,
): Promise<void> {
  const table = qualifyClickHouseTable(database, MIGRATIONS_TABLE);
  await client.command({
    query: `CREATE TABLE ${table} (version UInt32, name String, checksum FixedString(64), applied_at DateTime64(3, 'UTC') DEFAULT now64(3), execution_ms UInt64) ENGINE = MergeTree ORDER BY (version, applied_at)`,
    query_id: `ai_control_clickhouse_migration_table_${randomUUID()}`,
  });
}

export async function getClickHouseMigrationStatus(
  client: ClickHouseClient,
  database: string,
  localMigrations: readonly ClickHouseMigration[],
): Promise<ClickHouseMigrationStatusReport> {
  assertClickHouseMigrationSequence(localMigrations);
  assertClickHouseIdentifier(database, "ClickHouse database");
  const expectedObjects = getClickHouseBaselineObjects(localMigrations);
  const schemaObjects = await readSchemaObjects(client, database);
  const actualByName = new Map(schemaObjects.map((object) => [object.name, object.engine]));
  const migrationTableEngine = actualByName.get(MIGRATIONS_TABLE);
  const migrationTableExists = migrationTableEngine !== undefined;
  let migrationTableReadable = migrationTableEngine === "MergeTree";
  let applied: readonly AppliedMigrationRow[] = [];
  if (migrationTableReadable) {
    try {
      applied = await readAppliedMigrations(client, database);
    } catch {
      migrationTableReadable = false;
    }
  }
  const localByVersion = new Map(
    localMigrations.map((migration) => [migration.version, migration]),
  );
  const appliedByVersion = new Map(applied.map((migration) => [migration.version, migration]));
  const statuses: ClickHouseMigrationStatus[] = [];

  for (const migration of localMigrations) {
    const record = appliedByVersion.get(migration.version);
    let state: ClickHouseMigrationStatus["state"] = "pending";
    if (record !== undefined) {
      if (Number(record.application_count) !== 1) state = "duplicate_record";
      else if (record.name !== migration.name || record.checksum !== migration.checksum) {
        state = "checksum_mismatch";
      } else state = "applied";
    }
    statuses.push({
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
      appliedChecksum: record?.checksum ?? null,
      appliedAt: record?.applied_at_text ?? null,
      applicationCount: record === undefined ? 0 : Number(record.application_count),
      state,
    });
  }

  for (const record of applied) {
    if (localByVersion.has(record.version)) continue;
    statuses.push({
      version: record.version,
      name: record.name,
      checksum: record.checksum,
      appliedChecksum: record.checksum,
      appliedAt: record.applied_at_text,
      applicationCount: Number(record.application_count),
      state: "orphaned",
    });
  }
  statuses.sort((left, right) => left.version - right.version);

  const expectedByName = new Map(expectedObjects.map((object) => [object.name, object.engine]));
  const missingObjects = expectedObjects
    .filter((object) => !actualByName.has(object.name))
    .map((object) => object.name)
    .sort();
  const unexpectedObjects = schemaObjects
    .filter(
      (object) =>
        object.name !== MIGRATIONS_TABLE &&
        object.name !== MIGRATION_LOCK_TABLE &&
        !expectedByName.has(object.name),
    )
    .map((object) => object.name)
    .sort();
  const conflictingObjects = expectedObjects
    .flatMap((object) => {
      const actualEngine = actualByName.get(object.name);
      return actualEngine !== undefined && actualEngine !== object.engine
        ? [{ name: object.name, expectedEngine: object.engine, actualEngine }]
        : [];
    })
    .concat(
      migrationTableEngine !== undefined && migrationTableEngine !== "MergeTree"
        ? [
            {
              name: MIGRATIONS_TABLE,
              expectedEngine: "MergeTree",
              actualEngine: migrationTableEngine,
            },
          ]
        : [],
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const nonInternalObjects = schemaObjects.filter(
    (object) => object.name !== MIGRATIONS_TABLE && object.name !== MIGRATION_LOCK_TABLE,
  );
  const empty = !migrationTableExists && nonInternalObjects.length === 0;
  const installed =
    migrationTableExists &&
    migrationTableReadable &&
    statuses.length === localMigrations.length &&
    statuses.every((migration) => migration.state === "applied") &&
    missingObjects.length === 0 &&
    unexpectedObjects.length === 0 &&
    conflictingObjects.length === 0;
  const installationState = installed ? "installed" : empty ? "empty" : "partial_or_conflicting";
  return {
    migrationTableExists,
    migrationTableReadable,
    installationState,
    missingObjects,
    unexpectedObjects,
    conflictingObjects,
    migrations: statuses,
  };
}

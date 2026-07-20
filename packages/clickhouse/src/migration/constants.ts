import { assertClickHouseIdentifier } from "../config.js";

export const MIGRATION_FILE = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/u;
export const MIGRATIONS_TABLE = "clickhouse_schema_migrations";
export const MIGRATION_LOCK_TABLE = "__clickhouse_schema_migration_lock";

export function qualifyClickHouseTable(database: string, table: string): string {
  return `${assertClickHouseIdentifier(database, "ClickHouse database")}.${assertClickHouseIdentifier(table, "ClickHouse table")}`;
}

export const clickHouseMigrationInternals = Object.freeze({
  migrationsTable: MIGRATIONS_TABLE,
  migrationLockTable: MIGRATION_LOCK_TABLE,
});

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { ClickHouseMigrationError } from "../errors.js";
import { MIGRATION_FILE } from "./constants.js";
import type { ClickHouseBaselineObject, ClickHouseMigration } from "./types.js";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function parseMigrationFile(fileName: string): { readonly version: number; readonly name: string } {
  const match = MIGRATION_FILE.exec(fileName);
  if (match === null)
    throw new ClickHouseMigrationError(`Invalid ClickHouse migration filename: ${fileName}`);
  const versionText = match[1];
  const name = match[2];
  if (versionText === undefined || name === undefined) {
    throw new ClickHouseMigrationError(`Invalid ClickHouse migration filename: ${fileName}`);
  }
  const version = Number(versionText);
  if (version === 0) {
    throw new ClickHouseMigrationError(
      `ClickHouse migration version must be greater than zero: ${fileName}`,
    );
  }
  return { version, name };
}

export function assertClickHouseMigrationSequence(
  migrations: readonly ClickHouseMigration[],
): void {
  if (migrations.length === 0) {
    throw new ClickHouseMigrationError("ClickHouse current baseline contains no SQL statements");
  }
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    const expectedVersion = index + 1;
    const discoveredVersion = migration?.version;
    if (discoveredVersion !== expectedVersion) {
      if (discoveredVersion !== undefined && discoveredVersion === migrations[index - 1]?.version) {
        throw new ClickHouseMigrationError(
          `Duplicate ClickHouse migration version ${discoveredVersion}`,
        );
      }
      throw new ClickHouseMigrationError(
        `Missing ClickHouse migration version ${expectedVersion}; discovered ${discoveredVersion ?? "none"}`,
      );
    }
  }
}

function executableStatement(sql: string, fileName: string): string {
  const withoutComments = sql.replace(/^\s*--.*$/gmu, "").trim();
  const statement = withoutComments.endsWith(";")
    ? withoutComments.slice(0, -1).trim()
    : withoutComments;
  if (statement === "" || statement.includes(";")) {
    throw new ClickHouseMigrationError(
      `ClickHouse baseline file must contain exactly one SQL statement: ${fileName}`,
    );
  }
  return statement;
}

export function getClickHouseBaselineObjects(
  migrations: readonly ClickHouseMigration[],
): readonly ClickHouseBaselineObject[] {
  assertClickHouseMigrationSequence(migrations);
  const objects: ClickHouseBaselineObject[] = [];
  const names = new Set<string>();
  for (const migration of migrations) {
    const statement = executableStatement(migration.sql, migration.fileName);
    const create =
      /^CREATE\s+(TABLE|MATERIALIZED\s+VIEW|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z][a-z0-9_]*)(?=\s|\()/iu.exec(
        statement,
      );
    const kind = create?.[1]?.toUpperCase().replace(/\s+/gu, " ");
    const name = create?.[2];
    if (kind === undefined || name === undefined) {
      throw new ClickHouseMigrationError(
        `ClickHouse baseline file must create one unqualified table or view: ${migration.fileName}`,
      );
    }
    if (names.has(name)) {
      throw new ClickHouseMigrationError(
        `ClickHouse current baseline creates object more than once: ${name}`,
      );
    }
    let engine: string;
    if (kind === "VIEW") engine = "View";
    else if (kind === "MATERIALIZED VIEW") engine = "MaterializedView";
    else {
      const engineMatch = /\bENGINE\s*=\s*([A-Za-z][A-Za-z0-9]*)\b/u.exec(statement);
      const tableEngine = engineMatch?.[1];
      if (tableEngine === undefined) {
        throw new ClickHouseMigrationError(
          `ClickHouse baseline table must declare a literal engine: ${migration.fileName}`,
        );
      }
      engine = tableEngine;
    }
    names.add(name);
    objects.push({ name, engine });
  }
  return objects;
}

export async function discoverClickHouseMigrations(
  migrationsDirectory: string,
): Promise<readonly ClickHouseMigration[]> {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const migrations: ClickHouseMigration[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".sql")) continue;
    const { version, name } = parseMigrationFile(entry.name);
    const absolutePath = path.join(migrationsDirectory, entry.name);
    const sql = await readFile(absolutePath, "utf8");
    if (sql.trim() === "") {
      throw new ClickHouseMigrationError(`ClickHouse migration ${entry.name} is empty`);
    }
    if (sql.includes("\0")) {
      throw new ClickHouseMigrationError(`ClickHouse migration ${entry.name} contains a NUL byte`);
    }
    migrations.push({
      version,
      name,
      fileName: entry.name,
      absolutePath,
      checksum: sha256(sql),
      sql,
    });
  }
  migrations.sort((left, right) => left.version - right.version);
  assertClickHouseMigrationSequence(migrations);
  getClickHouseBaselineObjects(migrations);
  return migrations;
}

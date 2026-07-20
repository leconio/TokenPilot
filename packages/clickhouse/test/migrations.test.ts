import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ClickHouseClient } from "@clickhouse/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyClickHouseMigrations,
  ClickHouseMigrationError,
  ClickHouseMigrationLockError,
  discoverClickHouseMigrations,
  getClickHouseBaselineObjects,
  getClickHouseMigrationStatus,
  verifyClickHouseMigrations,
  type ClickHouseMigration,
} from "../src/index.js";

interface AppliedRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at_text: string;
  readonly application_count: string;
}

interface MutableBaselineState {
  readonly objects: Map<string, string>;
  applied: AppliedRow[];
}

const temporaryDirectories: string[] = [];
const localMigration: ClickHouseMigration = {
  version: 1,
  name: "probe",
  fileName: "0001_probe.sql",
  absolutePath: "/tmp/0001_probe.sql",
  checksum: "a".repeat(64),
  sql: "CREATE TABLE IF NOT EXISTS probe (id UInt8) ENGINE = Memory",
};
const secondMigration: ClickHouseMigration = {
  version: 2,
  name: "second",
  fileName: "0002_second.sql",
  absolutePath: "/tmp/0002_second.sql",
  checksum: "b".repeat(64),
  sql: "CREATE VIEW IF NOT EXISTS second AS SELECT * FROM probe",
};

function appliedRow(migration = localMigration): AppliedRow {
  return {
    version: migration.version,
    name: migration.name,
    checksum: migration.checksum,
    applied_at_text: "2026-07-17 00:00:00.000",
    application_count: "1",
  };
}

function jsonResult(rows: readonly unknown[]) {
  return { json: vi.fn().mockResolvedValue(rows) };
}

function statusClient(state: MutableBaselineState): ClickHouseClient {
  return {
    query: vi.fn(async ({ query }: { query: string }) =>
      query.includes("FROM system.tables")
        ? jsonResult(
            [...state.objects].map(([name, engine]) => ({
              name,
              engine,
            })),
          )
        : jsonResult(state.applied),
    ),
  } as unknown as ClickHouseClient;
}

function migrationClient(
  state: MutableBaselineState,
  options: {
    readonly lockError?: unknown;
    readonly migrationError?: unknown;
    readonly unlockError?: unknown;
    readonly insertError?: unknown;
  } = {},
) {
  const command = vi.fn(async ({ query }: { query: string }) => {
    if (query.startsWith("CREATE TABLE ai_control_plane.__clickhouse_schema_migration_lock")) {
      if (options.lockError !== undefined) throw options.lockError;
      state.objects.set("__clickhouse_schema_migration_lock", "Memory");
      return;
    }
    if (query.startsWith("DROP TABLE IF EXISTS")) {
      if (options.unlockError !== undefined) throw options.unlockError;
      state.objects.delete("__clickhouse_schema_migration_lock");
      return;
    }
    if (query.startsWith("CREATE TABLE ai_control_plane.clickhouse_schema_migrations")) {
      state.objects.set("clickhouse_schema_migrations", "MergeTree");
      return;
    }
    if (query === localMigration.sql) {
      if (options.migrationError !== undefined) throw options.migrationError;
      state.objects.set("probe", "Memory");
      return;
    }
    if (query === secondMigration.sql) state.objects.set("second", "View");
  });
  const query = vi.fn(async ({ query: sql }: { query: string }) => {
    if (sql.includes("version() AS version")) {
      return jsonResult([{ version: "26.3.17.4", database: "ai_control_plane" }]);
    }
    if (sql.includes("FROM system.tables")) {
      return jsonResult([...state.objects].map(([name, engine]) => ({ name, engine })));
    }
    return jsonResult(state.applied);
  });
  const insert = vi.fn(async ({ values }: { values: readonly Record<string, unknown>[] }) => {
    if (options.insertError !== undefined) throw options.insertError;
    const value = values[0];
    if (value === undefined) throw new Error("missing history row");
    state.applied.push({
      version: Number(value.version),
      name: String(value.name),
      checksum: String(value.checksum),
      applied_at_text: "2026-07-17 00:00:00.000",
      application_count: "1",
    });
  });
  return {
    client: { command, query, insert } as unknown as ClickHouseClient,
    command,
    insert,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tokenpilot-ch-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ClickHouse current baseline discovery", () => {
  it("sorts and hashes one CREATE statement per file", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, "0002_second.sql"),
      "CREATE VIEW second AS SELECT * FROM first\n",
    );
    await writeFile(
      path.join(directory, "0001_first.sql"),
      "CREATE TABLE first (id UInt64) ENGINE=Memory\n",
    );
    await writeFile(path.join(directory, "README.md"), "ignored\n");

    const migrations = await discoverClickHouseMigrations(directory);
    expect(migrations.map((migration) => migration.version)).toEqual([1, 2]);
    expect(migrations[0]?.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(getClickHouseBaselineObjects(migrations)).toEqual([
      { name: "first", engine: "Memory" },
      { name: "second", engine: "View" },
    ]);
  });

  it.each([
    [
      "duplicate versions",
      [
        ["0001_first.sql", "CREATE TABLE first (id UInt8) ENGINE=Memory"],
        ["0001_again.sql", "CREATE TABLE again (id UInt8) ENGINE=Memory"],
      ],
      "Duplicate ClickHouse migration version 1",
    ],
    [
      "sequence gaps",
      [
        ["0001_first.sql", "CREATE TABLE first (id UInt8) ENGINE=Memory"],
        ["0003_third.sql", "CREATE TABLE third (id UInt8) ENGINE=Memory"],
      ],
      "Missing ClickHouse migration version 2",
    ],
    ["empty SQL", [["0001_empty.sql", "  \n"]], "is empty"],
    [
      "unversioned SQL",
      [["create_probe.sql", "CREATE TABLE probe (id UInt8) ENGINE=Memory"]],
      "Invalid ClickHouse migration filename",
    ],
    [
      "version zero",
      [["0000_reserved.sql", "CREATE TABLE probe (id UInt8) ENGINE=Memory"]],
      "version must be greater than zero",
    ],
    [
      "non-CREATE SQL",
      [["0001_alter.sql", "ALTER TABLE probe ADD COLUMN value UInt8"]],
      "must create one unqualified table or view",
    ],
    [
      "qualified object names",
      [["0001_qualified.sql", "CREATE TABLE other.probe (id UInt8) ENGINE=Memory"]],
      "must create one unqualified table or view",
    ],
    [
      "multiple statements",
      [["0001_many.sql", "CREATE TABLE first (id UInt8) ENGINE=Memory; SELECT 1"]],
      "exactly one SQL statement",
    ],
  ] as const)("rejects %s", async (_label, files, message) => {
    const directory = await temporaryDirectory();
    await Promise.all(
      files.map(([name, contents]) => writeFile(path.join(directory, name), contents)),
    );
    await expect(discoverClickHouseMigrations(directory)).rejects.toThrowError(message);
  });

  it("rejects an empty baseline and duplicate object declarations", async () => {
    const empty = await temporaryDirectory();
    await expect(discoverClickHouseMigrations(empty)).rejects.toThrowError("contains no SQL");

    const duplicate = await temporaryDirectory();
    await writeFile(
      path.join(duplicate, "0001_first.sql"),
      "CREATE TABLE probe (id UInt8) ENGINE=Memory",
    );
    await writeFile(path.join(duplicate, "0002_second.sql"), "CREATE VIEW probe AS SELECT 1");
    await expect(discoverClickHouseMigrations(duplicate)).rejects.toThrowError(
      "creates object more than once",
    );
  });
});

describe("ClickHouse fresh-only baseline state", () => {
  it("reports empty and complete checksum-matched installations", async () => {
    const empty = await getClickHouseMigrationStatus(
      statusClient({ objects: new Map(), applied: [] }),
      "ai_control_plane",
      [localMigration],
    );
    expect(empty).toMatchObject({
      migrationTableExists: false,
      installationState: "empty",
      missingObjects: ["probe"],
    });

    const installed = await getClickHouseMigrationStatus(
      statusClient({
        objects: new Map([
          ["clickhouse_schema_migrations", "MergeTree"],
          ["probe", "Memory"],
        ]),
        applied: [appliedRow()],
      }),
      "ai_control_plane",
      [localMigration],
    );
    expect(installed).toMatchObject({
      migrationTableReadable: true,
      installationState: "installed",
      missingObjects: [],
      unexpectedObjects: [],
      conflictingObjects: [],
      migrations: [expect.objectContaining({ state: "applied" })],
    });
  });

  it.each([
    [
      "changed checksum",
      new Map([
        ["clickhouse_schema_migrations", "MergeTree"],
        ["probe", "Memory"],
      ]),
      [{ ...appliedRow(), checksum: "b".repeat(64) }],
      "checksum_mismatch",
    ],
    [
      "partial objects",
      new Map([["clickhouse_schema_migrations", "MergeTree"]]),
      [],
      "missing=probe",
    ],
    [
      "old object",
      new Map([["legacy_usage_events", "MergeTree"]]),
      [],
      "unexpected=legacy_usage_events",
    ],
    [
      "wrong engine",
      new Map([
        ["clickhouse_schema_migrations", "MergeTree"],
        ["probe", "MergeTree"],
      ]),
      [appliedRow()],
      "conflicting=probe",
    ],
    [
      "orphaned history",
      new Map([
        ["clickhouse_schema_migrations", "MergeTree"],
        ["probe", "Memory"],
      ]),
      [appliedRow(), { ...appliedRow(secondMigration), version: 999 }],
      "orphaned",
    ],
  ] as const)("rejects %s and requires recreation", async (_label, objects, applied, detail) => {
    const client = statusClient({ objects: new Map(objects), applied: [...applied] });
    const report = await getClickHouseMigrationStatus(client, "ai_control_plane", [localMigration]);
    expect(report.installationState).toBe("partial_or_conflicting");
    await expect(
      verifyClickHouseMigrations(client, "ai_control_plane", [localMigration]),
    ).rejects.toThrowError(new RegExp(`${detail}[\\s\\S]*delete and recreate`, "u"));
  });

  it("installs the whole baseline once and makes the second run a no-op", async () => {
    const state: MutableBaselineState = { objects: new Map(), applied: [] };
    const fixture = migrationClient(state);
    await expect(
      applyClickHouseMigrations(fixture.client, "ai_control_plane", [
        localMigration,
        secondMigration,
      ]),
    ).resolves.toMatchObject({ appliedVersions: [1, 2] });
    await expect(
      applyClickHouseMigrations(fixture.client, "ai_control_plane", [
        localMigration,
        secondMigration,
      ]),
    ).resolves.toMatchObject({ appliedVersions: [] });
    expect(
      fixture.command.mock.calls.filter(([input]) =>
        [localMigration.sql, secondMigration.sql].includes((input as { query: string }).query),
      ),
    ).toHaveLength(2);
  });

  it("never resumes an incomplete installation", async () => {
    const state: MutableBaselineState = { objects: new Map(), applied: [] };
    const fixture = migrationClient(state, { insertError: new Error("history unavailable") });
    await expect(
      applyClickHouseMigrations(fixture.client, "ai_control_plane", [localMigration]),
    ).rejects.toThrowError(/history unavailable[\s\S]*delete and recreate/u);
    await expect(
      applyClickHouseMigrations(fixture.client, "ai_control_plane", [localMigration]),
    ).rejects.toThrowError(/partial, conflicting, or old schema/u);
    expect(
      fixture.command.mock.calls.filter(
        ([input]) => (input as { query: string }).query === localMigration.sql,
      ),
    ).toHaveLength(1);
  });

  it("distinguishes lock contention and preserves cleanup failures", async () => {
    const contention = migrationClient(
      { objects: new Map(), applied: [] },
      { lockError: Object.assign(new Error("table exists"), { code: "57" }) },
    );
    await expect(
      applyClickHouseMigrations(contention.client, "ai_control_plane", [localMigration]),
    ).rejects.toBeInstanceOf(ClickHouseMigrationLockError);

    const primary = new Error("baseline statement failed");
    const cleanup = migrationClient(
      { objects: new Map(), applied: [] },
      { migrationError: primary, unlockError: new Error("unlock failed") },
    );
    const error = await applyClickHouseMigrations(cleanup.client, "ai_control_plane", [
      localMigration,
    ]).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "ClickHouseMigrationError", cause: primary });
    expect((error as Error).message).toMatch(/delete and recreate[\s\S]*failed to release/u);
  });

  it("rejects verification on an empty database without asking for a compatibility path", async () => {
    await expect(
      verifyClickHouseMigrations(
        statusClient({ objects: new Map(), applied: [] }),
        "ai_control_plane",
        [localMigration],
      ),
    ).rejects.toThrowError("current baseline is not installed in empty database");
  });

  it("uses the typed migration error for invalid baseline input", async () => {
    await expect(
      getClickHouseMigrationStatus(
        statusClient({ objects: new Map(), applied: [] }),
        "ai_control_plane",
        [],
      ),
    ).rejects.toBeInstanceOf(ClickHouseMigrationError);
  });
});

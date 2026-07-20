#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createClickHouseClient,
  identifier,
  listDatabaseObjects,
} from "../../release/lib/clickhouse-fresh-rebuild.mjs";

const executeFile = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const target = process.env.CLICKHOUSE_ACCEPTANCE_TARGET ?? "";
if (target.length === 0 || /prod(?:uction)?/iu.test(target)) {
  throw new Error("CLICKHOUSE_ACCEPTANCE_TARGET must name a disposable non-production target");
}
if (process.env.CLICKHOUSE_ACCEPTANCE_ACK !== "disposable-fresh-database") {
  throw new Error("CLICKHOUSE_ACCEPTANCE_ACK=disposable-fresh-database is required");
}

const client = createClickHouseClient();
if (!/^ai_control_acceptance_[a-z0-9_]+$/u.test(client.database)) {
  throw new Error("fresh rebuild acceptance requires its run-scoped ClickHouse database");
}
const evidenceDirectory = resolve(
  process.env.CLICKHOUSE_ACCEPTANCE_EVIDENCE ??
    `artifacts/release/clickhouse-fresh-rebuild-${Date.now()}`,
);
await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });

const conflictTable = `obsolete_acceptance_${process.pid}_${Date.now().toString(36)}`.toLowerCase();
await client.execute(
  `CREATE TABLE ${identifier(client.database)}.${identifier(conflictTable)} (value UInt8) ENGINE = Memory`,
);
await client.execute(
  `INSERT INTO ${identifier(client.database)}.${identifier(conflictTable)} VALUES (1)`,
);

const rebuildId = randomUUID();
const planPath = resolve(evidenceDirectory, "fresh-plan.json");
const evidencePath = resolve(evidenceDirectory, "fresh-rebuild.json");
await writeFile(
  planPath,
  `${JSON.stringify(
    {
      rebuildId,
      database: client.database,
      steps: [
        "clear_isolated_database",
        "create_current_schema",
        "replay_postgresql_outbox",
        "verify_current_projection",
      ],
    },
    null,
    2,
  )}\n`,
  { encoding: "utf8", mode: 0o600 },
);

const result = await executeFile(
  process.execPath,
  [
    resolve(root, "scripts/release/clickhouse-fresh-rebuild.mjs"),
    "--plan",
    planPath,
    "--actor",
    "acceptance-runner",
    "--reason",
    "Replace an intentionally conflicting isolated schema with the current schema",
    "--evidence",
    evidencePath,
    "--acknowledge-fresh-database",
  ],
  {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 20 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
  },
);
const output = result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
if (output === undefined || JSON.parse(output).status !== "passed") {
  throw new Error("fresh rebuild command returned no passing result");
}
const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
if (
  evidence.status !== "passed" ||
  evidence.mode !== "fresh_only" ||
  evidence.schema_conflict_action !== "clear_and_create_current_schema" ||
  evidence.historical_schema_retained !== false ||
  evidence.ownership_marker_verified !== true ||
  !Number.isSafeInteger(evidence.retained_input_count) ||
  evidence.retained_input_count < 1 ||
  evidence.replayed_outbox_count !== evidence.retained_input_count
) {
  throw new Error("fresh rebuild evidence is incomplete");
}
const objects = await listDatabaseObjects(client);
if (objects.some((object) => object.name === conflictTable)) {
  throw new Error("fresh rebuild retained the intentionally conflicting schema object");
}

process.stdout.write(
  `${JSON.stringify(
    {
      target,
      database: client.database,
      conflict_destroyed: "pass",
      current_schema_created: "pass",
      postgresql_outbox_replayed: "pass",
      current_projection_verified: "pass",
      retained_input_count: evidence.retained_input_count,
      evidence: evidencePath,
    },
    null,
    2,
  )}\n`,
);

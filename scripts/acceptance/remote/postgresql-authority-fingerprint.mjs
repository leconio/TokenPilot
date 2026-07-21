#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdir, open, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const requireFromDatabasePackage = createRequire(
  new URL("../../../packages/db/package.json", import.meta.url),
);
const { Client } = requireFromDatabasePackage("pg");

export const AUTHORITY_TABLES = Object.freeze(
  [
    "_prisma_migrations",
    "account",
    "application_api_keys",
    "application_dashboard_cards",
    "application_members",
    "application_settings",
    "application_usage_ratings",
    "application_user_group_bulk_actions",
    "application_user_group_evaluations",
    "application_user_group_members",
    "application_user_groups",
    "application_users",
    "applications",
    "audit_logs",
    "background_jobs",
    "clickhouse_sync_state",
    "connector_heartbeat_receipts",
    "connector_instances",
    "dead_letter_events",
    "ingestion_inbox",
    "instance_settings",
    "model_aiu_items",
    "model_aiu_versions",
    "model_cost_rule_items",
    "model_cost_rules",
    "model_cost_versions",
    "model_definitions",
    "pipeline_outbox",
    "property_definitions",
    "rate_limit",
    "reconciliation_diffs",
    "reconciliation_runs",
    "runtime_configuration_acknowledgements",
    "runtime_configuration_versions",
    "saved_reports",
    "session",
    "usage_event_registry",
    "user",
    "user_aiu_ledger_entries",
    "user_aiu_quotas",
    "user_aiu_reservations",
    "verification",
    "virtual_model_rules",
    "virtual_model_targets",
    "virtual_models",
  ].sort(),
);

const WATERMARK_COLUMNS = [
  "updated_at",
  "created_at",
  "event_time",
  "received_at",
  "finished_at",
  "started_at",
  "published_at",
  "effective_from",
  "period_start",
  "issued_at",
];
const TEMPORAL_TYPES = new Set(["date", "timestamp with time zone", "timestamp without time zone"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function quoteIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new TypeError(`Unsafe PostgreSQL identifier: ${value}`);
  }
  return `"${value}"`;
}

export function buildCopyQuery(table, primaryKey, snapshot) {
  if (!/^[0-9A-F-]+$/iu.test(snapshot)) throw new TypeError("Invalid PostgreSQL snapshot id");
  if (primaryKey.length === 0) throw new TypeError(`Table ${table} has no primary key`);
  const tableIdentifier = quoteIdentifier(table);
  const order = primaryKey
    .map((column) => `convert_to(${quoteIdentifier(column)}::text, 'UTF8')`)
    .join(", ");
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT '${snapshot}';
COPY (
  SELECT to_jsonb(ordered_row)::text
  FROM (
    SELECT * FROM public.${tableIdentifier} ORDER BY ${order}
  ) AS ordered_row
) TO STDOUT;
COMMIT;`;
}

export function psqlEnvironment(databaseUrl, environment = process.env) {
  const parsed = new URL(databaseUrl);
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol) || parsed.pathname.length < 2) {
    throw new TypeError("The selected database environment variable is not a PostgreSQL URL");
  }
  const result = { ...environment };
  for (const name of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGSERVICE"]) {
    delete result[name];
  }
  result.PGHOST = parsed.hostname;
  result.PGPORT = parsed.port || "5432";
  result.PGUSER = decodeURIComponent(parsed.username);
  result.PGPASSWORD = decodeURIComponent(parsed.password);
  result.PGDATABASE = decodeURIComponent(parsed.pathname.slice(1));
  result.PGAPPNAME = "tokenpilot-authority-fingerprint";
  result.PGOPTIONS = [
    environment.PGOPTIONS,
    "-c timezone=UTC",
    "-c datestyle=ISO,MDY",
    "-c extra_float_digits=3",
  ]
    .filter(Boolean)
    .join(" ");
  return result;
}

async function hashCopyStream(databaseUrl, query) {
  const digest = createHash("sha256");
  let stderr = "";
  await new Promise((resolvePromise, reject) => {
    const child = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", query], {
      env: psqlEnvironment(databaseUrl),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => digest.update(chunk));
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 65_536) stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        reject(
          new Error(
            `PostgreSQL fingerprint stream failed (${signal ?? `exit ${String(code)}`}): ${stderr.trim()}`,
          ),
        );
      }
    });
  });
  return digest.digest("hex");
}

function groupByTable(rows) {
  const grouped = new Map(AUTHORITY_TABLES.map((table) => [table, []]));
  for (const row of rows) grouped.get(row.table_name)?.push(row);
  return grouped;
}

async function catalogMetadata(database) {
  const columns = await database.query(
    `SELECT table_name, column_name, ordinal_position, data_type, udt_name,
            is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position`,
    [AUTHORITY_TABLES],
  );
  const primaryKeys = await database.query(
    `SELECT relation.relname AS table_name, attribute.attname AS column_name,
            key_column.ordinality AS ordinal_position
       FROM pg_index AS index_definition
       JOIN pg_class AS relation ON relation.oid = index_definition.indrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       JOIN unnest(index_definition.indkey) WITH ORDINALITY
         AS key_column(attribute_number, ordinality) ON true
       JOIN pg_attribute AS attribute
         ON attribute.attrelid = relation.oid
        AND attribute.attnum = key_column.attribute_number
      WHERE namespace.nspname = 'public' AND index_definition.indisprimary
        AND relation.relname = ANY($1::text[])
      ORDER BY relation.relname, key_column.ordinality`,
    [AUTHORITY_TABLES],
  );
  const constraints = await database.query(
    `SELECT relation.relname AS table_name, constraint_definition.conname AS name,
            constraint_definition.contype AS type,
            pg_get_constraintdef(constraint_definition.oid, true) AS definition
       FROM pg_constraint AS constraint_definition
       JOIN pg_class AS relation ON relation.oid = constraint_definition.conrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relname = ANY($1::text[])
      ORDER BY relation.relname, constraint_definition.conname`,
    [AUTHORITY_TABLES],
  );
  const indexes = await database.query(
    `SELECT tablename AS table_name, indexname AS name, indexdef AS definition
       FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ANY($1::text[])
      ORDER BY tablename, indexname`,
    [AUTHORITY_TABLES],
  );
  const triggers = await database.query(
    `SELECT relation.relname AS table_name, trigger_definition.tgname AS name,
            pg_get_triggerdef(trigger_definition.oid, true) AS definition
       FROM pg_trigger AS trigger_definition
       JOIN pg_class AS relation ON relation.oid = trigger_definition.tgrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND NOT trigger_definition.tgisinternal
        AND relation.relname = ANY($1::text[])
      ORDER BY relation.relname, trigger_definition.tgname`,
    [AUTHORITY_TABLES],
  );
  return {
    columns: groupByTable(columns.rows),
    constraints: groupByTable(constraints.rows),
    indexes: groupByTable(indexes.rows),
    primaryKeys: groupByTable(primaryKeys.rows),
    triggers: groupByTable(triggers.rows),
  };
}

function schemaDigest(metadata, table) {
  return sha256(
    JSON.stringify({
      columns: metadata.columns.get(table),
      constraints: metadata.constraints.get(table),
      indexes: metadata.indexes.get(table),
      primary_key: metadata.primaryKeys.get(table),
      triggers: metadata.triggers.get(table),
    }),
  );
}

async function tableSummary(database, databaseUrl, metadata, snapshot, table) {
  const columns = metadata.columns.get(table) ?? [];
  if (columns.length === 0) throw new Error(`Required authority table is missing: ${table}`);
  const primaryKey = (metadata.primaryKeys.get(table) ?? []).map((row) => row.column_name);
  const watermarkColumn = WATERMARK_COLUMNS.find((candidate) =>
    columns.some(
      (column) => column.column_name === candidate && TEMPORAL_TYPES.has(column.data_type),
    ),
  );
  const watermarkSelection =
    watermarkColumn === undefined
      ? "NULL::text AS minimum, NULL::text AS maximum"
      : `MIN(${quoteIdentifier(watermarkColumn)})::text AS minimum,
         MAX(${quoteIdentifier(watermarkColumn)})::text AS maximum`;
  const summary = await database.query(
    `SELECT count(*)::text AS row_count, ${watermarkSelection}
       FROM public.${quoteIdentifier(table)}`,
  );
  const row = summary.rows[0];
  return {
    row_count: row.row_count,
    watermark:
      watermarkColumn === undefined
        ? null
        : { column: watermarkColumn, minimum: row.minimum, maximum: row.maximum },
    schema_sha256: schemaDigest(metadata, table),
    rows_sha256: await hashCopyStream(databaseUrl, buildCopyQuery(table, primaryKey, snapshot)),
  };
}

export function comparableFingerprint(document) {
  return {
    fingerprint_version: document.fingerprint_version,
    table_count: document.table_count,
    tables: Object.fromEntries(
      Object.entries(document.tables ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

export function authorityDigest(document) {
  return sha256(JSON.stringify(comparableFingerprint(document)));
}

export async function createAuthorityFingerprint(databaseUrl) {
  const database = new Client({ connectionString: databaseUrl });
  await database.connect();
  try {
    await database.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await database.query("SET LOCAL TIME ZONE 'UTC'");
    await database.query("SET LOCAL datestyle = 'ISO, MDY'");
    const metadata = await catalogMetadata(database);
    const snapshotResult = await database.query("SELECT pg_export_snapshot() AS snapshot");
    const snapshot = snapshotResult.rows[0]?.snapshot;
    if (typeof snapshot !== "string") throw new Error("PostgreSQL did not export a snapshot");
    const tables = {};
    for (const table of AUTHORITY_TABLES) {
      tables[table] = await tableSummary(database, databaseUrl, metadata, snapshot, table);
    }
    const document = {
      schema_version: "current",
      fingerprint_version: 1,
      captured_at: new Date().toISOString(),
      table_count: AUTHORITY_TABLES.length,
      tables,
    };
    return { ...document, authority_sha256: authorityDigest(document) };
  } finally {
    await database.query("ROLLBACK").catch(() => undefined);
    await database.end();
  }
}

function parseArguments(arguments_) {
  let databaseEnvironment = "DATABASE_URL";
  let output;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--database-url-env") databaseEnvironment = arguments_[++index];
    else if (argument === "--output") output = arguments_[++index];
    else
      throw new TypeError(
        "Usage: postgresql-authority-fingerprint.mjs [--database-url-env NAME] --output FILE",
      );
  }
  if (!/^[A-Z][A-Z0-9_]*$/u.test(databaseEnvironment ?? "") || output === undefined) {
    throw new TypeError(
      "Usage: postgresql-authority-fingerprint.mjs [--database-url-env NAME] --output FILE",
    );
  }
  return { databaseEnvironment, output: resolve(output) };
}

export async function writePrivateJson(path, document) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const databaseUrl = process.env[options.databaseEnvironment];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error(
      `Required database environment variable is absent: ${options.databaseEnvironment}`,
    );
  }
  const document = await createAuthorityFingerprint(databaseUrl);
  await writePrivateJson(options.output, document);
  process.stdout.write(
    `${JSON.stringify({ status: "passed", output: options.output, table_count: document.table_count, authority_sha256: document.authority_sha256 })}\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "PostgreSQL authority fingerprint failed"}\n`,
    );
    process.exitCode = 1;
  });
}

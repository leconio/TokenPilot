#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { ulid } from "ulid";

import {
  createClickHouseClient,
  identifier,
  sqlString,
  writePrivateJson,
} from "../../release/lib/clickhouse-fresh-rebuild.mjs";

if (process.env.REMOTE_RECONCILIATION_FAULT_DRILL !== "true") {
  throw new Error("REMOTE_RECONCILIATION_FAULT_DRILL=true is required");
}
if (process.env.CLICKHOUSE_ACCEPTANCE_ACK !== "disposable-fresh-database") {
  throw new Error("CLICKHOUSE_ACCEPTANCE_ACK=disposable-fresh-database is required");
}
const acceptanceTarget = process.env.CLICKHOUSE_ACCEPTANCE_TARGET ?? "";
if (acceptanceTarget.length === 0 || /prod(?:uction)?/iu.test(acceptanceTarget)) {
  throw new Error("CLICKHOUSE_ACCEPTANCE_TARGET must name a disposable non-production target");
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

const apiUrl = requiredEnvironment("RECONCILIATION_FAULT_API_URL").replace(/\/$/u, "");
const apiKey = requiredEnvironment("RELEASE_ADMIN_API_KEY");
const eventId = requiredEnvironment("RECONCILIATION_FAULT_EVENT_ID");
const applicationId = requiredEnvironment("RECONCILIATION_FAULT_APPLICATION_ID");
const applicationSlug = requiredEnvironment("RECONCILIATION_FAULT_APPLICATION_SLUG");
const baseRangeFrom = new Date(requiredEnvironment("RECONCILIATION_FAULT_RANGE_FROM"));
const baseRangeTo = new Date(requiredEnvironment("RECONCILIATION_FAULT_RANGE_TO"));
const apiHost = new URL(apiUrl).hostname;
if (!["api", "127.0.0.1", "localhost"].includes(apiHost)) {
  throw new Error("the reconciliation fault drill requires isolated internal API ingress");
}
if (!/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(eventId)) {
  throw new Error("RECONCILIATION_FAULT_EVENT_ID must be a canonical ULID");
}
if (!/^[0-9a-f-]{36}$/iu.test(applicationId)) {
  throw new Error("RECONCILIATION_FAULT_APPLICATION_ID must be a UUID");
}
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(applicationSlug)) {
  throw new Error("RECONCILIATION_FAULT_APPLICATION_SLUG is invalid");
}
const reconciliationPath = `/applications/${encodeURIComponent(applicationSlug)}/reconciliation`;
if (
  !Number.isFinite(baseRangeFrom.getTime()) ||
  !Number.isFinite(baseRangeTo.getTime()) ||
  baseRangeTo <= baseRangeFrom
) {
  throw new Error("the reconciliation fault range is invalid");
}

const client = createClickHouseClient();
const executeFile = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const evidenceDirectory = resolve(
  process.env.CLICKHOUSE_RECONCILIATION_EVIDENCE ??
    `artifacts/acceptance/reconciliation-fault-${Date.now()}`,
);
await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });

async function queryJson(query) {
  const body = await client.execute(`${query}\nFORMAT JSONEachRow`);
  const rows = body
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
  return rows;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${apiKey}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { response, body, text };
}

async function poll(callback, description, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await callback();
    if (last !== undefined) return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`${description} did not complete: ${JSON.stringify(last)}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function samplesContainEvent(diff) {
  return Array.isArray(diff.sample_event_ids) && diff.sample_event_ids.includes(eventId);
}

async function compare(label, rangePaddingMs) {
  const rangeFrom = new Date(baseRangeFrom.getTime() - rangePaddingMs).toISOString();
  const rangeTo = new Date(baseRangeTo.getTime() + rangePaddingMs).toISOString();
  const created = await api(`${reconciliationPath}/runs`, {
    method: "POST",
    body: JSON.stringify({
      type: "manual",
      from: rangeFrom,
      to: rangeTo,
      reason: `Isolated acceptance ${label} reconciliation`,
    }),
  });
  if (created.response.status !== 201 || !isRecord(created.body) || !created.body.id) {
    throw new Error(`${label} reconciliation run was not created`);
  }
  const runId = String(created.body.id);
  const run = await poll(async () => {
    const result = await api(`${reconciliationPath}/runs/${encodeURIComponent(runId)}`);
    if (!result.response.ok || !isRecord(result.body)) {
      throw new Error(`${label} reconciliation polling failed`);
    }
    if (["failed", "cancelled"].includes(String(result.body.status))) {
      throw new Error(`${label} reconciliation ended with ${String(result.body.status)}`);
    }
    return result.body.status === "completed" ? result.body : undefined;
  }, `${label} reconciliation`);
  const listed = await api(
    `${reconciliationPath}/runs/${encodeURIComponent(runId)}/diffs?page=1&page_size=200`,
  );
  if (!listed.response.ok || !isRecord(listed.body) || !Array.isArray(listed.body.diffs)) {
    throw new Error(`${label} reconciliation diffs could not be read`);
  }
  const exported = await api(`${reconciliationPath}/runs/${encodeURIComponent(runId)}/export.csv`);
  if (!exported.response.ok || !exported.text.startsWith("type,severity,bucket_start")) {
    throw new Error(`${label} reconciliation export is invalid`);
  }
  await writeFile(resolve(evidenceDirectory, `${label}.csv`), exported.text, {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    run,
    runId,
    diffs: listed.body.diffs.filter(isRecord),
    rangeFrom,
    rangeTo,
  };
}

const eventRows = await queryJson(`
  SELECT toString(count()) AS row_count
  FROM ${identifier(client.database)}.current_usage_events_raw
  WHERE application_id = ${sqlString(applicationId)}
    AND event_id = ${sqlString(eventId)}
`);
if (eventRows.length !== 1 || eventRows[0].row_count !== "1") {
  throw new Error("the repaired reconciliation event is not singular in ClickHouse");
}

const baseline = await compare("missing-repair-recheck", 1);
await writePrivateJson(resolve(evidenceDirectory, "missing-repair-recheck.json"), {
  status: baseline.diffs.length === 0 ? "passed" : "failed",
  run_id: baseline.runId,
  range_from: baseline.rangeFrom,
  range_to: baseline.rangeTo,
  diff_count: baseline.diffs.length,
  diffs: baseline.diffs,
});
if (baseline.diffs.length !== 0) {
  throw new Error("the missing projection replay did not reconcile to zero diffs");
}

await client.execute(`
  INSERT INTO ${identifier(client.database)}.usage_events_raw
  SELECT *
  FROM ${identifier(client.database)}.current_usage_events_raw
  WHERE application_id = ${sqlString(applicationId)}
    AND event_id = ${sqlString(eventId)}
  LIMIT 1
`);

const faultRatingId = ulid();
const faultDeliveryId = `fault-delivery-${ulid()}`;
const faultOutboxId = `fault-outbox-${ulid()}`;
const faultFingerprint = `sha256:${"f".repeat(64)}`;
await client.execute(`
  INSERT INTO ${identifier(client.database)}.rating_events
  (
    application_id, instance_id, environment, event_time, rating_event_id, source_event_id,
    rating_kind, rating_stage, rating_sign, request_id, attempt_id, operation_id,
    user_id, virtual_model, model_id, model_tag, provider,
    status, attempt_outcome, route_reason, usage_type, currency, amount_decimal, aiu_micros,
    price_version_id, aiu_rate_version_id, calculation_version, rating_fingerprint,
    reason, sink_delivery_id, authority_outbox_id, source_outbox_id
  )
  SELECT
    application_id, instance_id, environment, event_time, ${sqlString(faultRatingId)}, event_id,
    'provider_cost', 'official', 1, request_id, attempt_id, operation_id,
    user_id, virtual_model, model_id, model_tag, provider,
    'official', status, route_reason, CAST(NULL AS Nullable(String)), CAST('USD' AS Nullable(String)),
    CAST(toDecimal128(1, 18) AS Nullable(Decimal(38, 18))), CAST(NULL AS Nullable(Int64)),
    CAST(NULL AS Nullable(String)), CAST(NULL AS Nullable(String)), 'acceptance-fault',
    ${sqlString(faultFingerprint)}, 'controlled amount mismatch',
    ${sqlString(faultDeliveryId)}, toUInt64('18446744073709551600'), ${sqlString(faultOutboxId)}
  FROM ${identifier(client.database)}.current_usage_events_raw
  WHERE application_id = ${sqlString(applicationId)}
    AND event_id = ${sqlString(eventId)}
  LIMIT 1
`);

const corruptedSummaries = {
  usage_events_raw: await queryJson(
    `SELECT toString(count()) AS row_count
     FROM ${identifier(client.database)}.usage_events_raw
     WHERE application_id = ${sqlString(applicationId)}`,
  ),
  rating_events: await queryJson(
    `SELECT toString(count()) AS row_count
     FROM ${identifier(client.database)}.rating_events
     WHERE application_id = ${sqlString(applicationId)}`,
  ),
};
const fault = await compare("controlled-faults", 1_000);
const ownFaults = fault.diffs.filter(samplesContainEvent);
const ownTypes = new Set(ownFaults.map((diff) => String(diff.diff_type)));
for (const expected of ["DUPLICATE_PROJECTION", "LEDGER_PROJECTION_MISSING"]) {
  if (!ownTypes.has(expected)) {
    throw new Error(`the controlled reconciliation drill did not detect ${expected}`);
  }
}

const rebuildId = randomUUID();
const rebuildPlanPath = resolve(evidenceDirectory, "fresh-rebuild-plan.json");
const rebuildEvidencePath = resolve(evidenceDirectory, "fresh-rebuild.json");
await writeFile(
  rebuildPlanPath,
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
const rebuildResult = await executeFile(
  process.execPath,
  [
    resolve(root, "scripts/release/clickhouse-fresh-rebuild.mjs"),
    "--plan",
    rebuildPlanPath,
    "--actor",
    "acceptance-runner",
    "--reason",
    "Destroy the controlled isolated corruption and replay retained PostgreSQL inputs",
    "--evidence",
    rebuildEvidencePath,
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
if (!rebuildResult.stdout.includes('"status":"passed"')) {
  throw new Error("the controlled corruption fresh rebuild did not pass");
}

const repaired = await compare("corruption-repair-recheck", 2_000);
if (repaired.diffs.length !== 0) {
  throw new Error("the controlled corruption repair did not reconcile to zero diffs");
}

for (const diff of ownFaults) {
  const resolved = await api(
    `${reconciliationPath}/diffs/${encodeURIComponent(String(diff.id))}/resolve`,
    {
      method: "POST",
      body: JSON.stringify({
        resolution: "corrected",
        note: "Controlled isolated fault repaired by a verified fresh ClickHouse rebuild",
      }),
    },
  );
  if (resolved.response.status !== 201 || !isRecord(resolved.body)) {
    throw new Error("a controlled reconciliation diff could not be marked corrected");
  }
}

const finalRows = {
  usage_events_raw: await queryJson(
    `SELECT toString(count()) AS row_count
     FROM ${identifier(client.database)}.current_usage_events_raw
     WHERE application_id = ${sqlString(applicationId)}`,
  ),
  rating_events: await queryJson(
    `SELECT toString(count()) AS row_count
     FROM ${identifier(client.database)}.current_rating_events
     WHERE application_id = ${sqlString(applicationId)}`,
  ),
};

const evidencePath = await writePrivateJson(resolve(evidenceDirectory, "result.json"), {
  status: "passed",
  target: acceptanceTarget,
  application_id: applicationId,
  application_slug: applicationSlug,
  event_id: eventId,
  baseline_run_id: baseline.runId,
  fault_run_id: fault.runId,
  repaired_run_id: repaired.runId,
  detected_types: [...ownTypes].sort(),
  detected_diff_count: ownFaults.length,
  exported_fault_csv: "controlled-faults.csv",
  corrupted_summaries: corruptedSummaries,
  fresh_rebuild_evidence: rebuildEvidencePath,
  final_projection_rows: finalRows,
  post_repair_diff_count: repaired.diffs.length,
  controlled_diffs_resolved: ownFaults.length,
});

process.stdout.write(
  `${JSON.stringify({ status: "passed", evidence: evidencePath, detected_types: [...ownTypes] })}\n`,
);

#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  CLICKHOUSE_REPLAY_EVENT_TYPES,
  CURRENT_PROJECTION_VIEWS,
  createClickHouseClient,
  expectedProjectionDeliveryIds,
  dropDatabaseObjects,
  expectedProjectionRows,
  listDatabaseObjects,
  projectionCounts,
  retainedInputChecksum,
  validateFreshPlan,
  validateFreshTarget,
  verifyProjectionDeliveryIds,
  writePrivateJson,
} from "./lib/clickhouse-fresh-rebuild.mjs";
import {
  waitForAggregateSemantics,
  waitForProjectionCounts,
} from "./lib/clickhouse-fresh-verification.mjs";

const executeFile = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pauseKey = "clickhouse:sink:pause";
const rebuildLockKey = "clickhouse:fresh-rebuild:lock";
const keyTtlMs = 3_600_000;

function parseArguments(arguments_) {
  const values = {};
  let acknowledged = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--acknowledge-fresh-database") {
      acknowledged = true;
      continue;
    }
    if (["--plan", "--actor", "--reason", "--evidence"].includes(argument)) {
      const value = arguments_[index + 1];
      if (value === undefined) throw new TypeError(`${argument} requires a value`);
      values[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new TypeError(`unknown argument: ${argument}`);
  }
  for (const key of ["plan", "actor", "reason", "evidence"]) {
    if (values[key] === undefined) throw new TypeError(`--${key} is required`);
  }
  if (!acknowledged) throw new TypeError("--acknowledge-fresh-database is required");
  if (values.actor.trim().length === 0 || values.actor.length > 256) {
    throw new TypeError("actor must contain 1 to 256 characters");
  }
  if (values.reason.trim().length < 5 || values.reason.length > 500) {
    throw new TypeError("reason must contain 5 to 500 characters");
  }
  return Object.freeze(values);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function acquireKey(redis, key, token) {
  const acquired = await redis.set(key, token, "PX", keyTtlMs, "NX");
  if (acquired !== "OK") throw new Error(`${key} is already held`);
}

async function releaseKey(redis, key, token) {
  const released = await redis.eval(
    "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
    1,
    key,
    token,
  );
  if (released !== 1) throw new Error(`${key} ownership was lost`);
}

async function ensurePaused(redis, token) {
  const current = await redis.get(pauseKey);
  if (current === token) return true;
  if (current !== null) throw new Error("ClickHouse delivery pause is held by another owner");
  await acquireKey(redis, pauseKey, token);
  return true;
}

export async function requeueExpiredClickHouseLeases(postgres) {
  const recoveryOwner = `fresh-rebuild-recovery:${randomUUID()}`;
  await postgres.query("BEGIN");
  try {
    const takeover = await postgres.query(
      `UPDATE pipeline_outbox
       SET status = 'leased', lease_owner = $2,
           lease_expires_at = statement_timestamp() + interval '30 seconds',
           attempt_count = attempt_count + 1, next_retry_at = NULL,
           last_error = NULL, updated_at = statement_timestamp()
       WHERE status = 'leased'
         AND lease_expires_at <= statement_timestamp()
         AND event_type = ANY($1::text[])
       RETURNING id::text`,
      [CLICKHOUSE_REPLAY_EVENT_TYPES, recoveryOwner],
    );
    const ids = takeover.rows.map((row) => row.id);
    if (ids.length > 0) {
      const retry = await postgres.query(
        `UPDATE pipeline_outbox
         SET status = 'failed',
             available_at = statement_timestamp() + interval '1 second',
             next_retry_at = statement_timestamp() + interval '1 second',
             last_error = 'fresh rebuild reclaimed an expired ClickHouse delivery lease',
             updated_at = statement_timestamp()
         WHERE id = ANY($1::bigint[])
           AND status = 'leased'
           AND lease_owner = $2
           AND lease_expires_at > statement_timestamp()`,
        [ids, recoveryOwner],
      );
      if (retry.rowCount !== ids.length) {
        throw new Error("expired ClickHouse delivery lease recovery lost ownership");
      }
    }
    await postgres.query("COMMIT");
    return ids.length;
  } catch (error) {
    await postgres.query("ROLLBACK");
    throw error;
  }
}

async function waitForNoLeases(postgres, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await requeueExpiredClickHouseLeases(postgres);
    const result = await postgres.query(
      `SELECT count(*)::integer AS count
       FROM pipeline_outbox
       WHERE status = 'leased' AND event_type = ANY($1::text[])`,
      [CLICKHOUSE_REPLAY_EVENT_TYPES],
    );
    if (result.rows[0]?.count === 0) return;
    await sleep(250);
  }
  throw new Error("ClickHouse Outbox leases did not drain before the fresh rebuild");
}

async function retainedRows(postgres) {
  const result = await postgres.query(
    `SELECT outbox.id::text, outbox.application_id::text, outbox.event_type, outbox.payload_json,
            outbox.replay_of_outbox_id::text
     FROM pipeline_outbox AS outbox
     WHERE outbox.status = 'sent'
       AND outbox.event_type = ANY($1::text[])
       AND outbox.idempotency_key NOT LIKE 'fresh-rebuild:%'
       AND outbox.idempotency_key NOT LIKE 'reconciliation:%'
     ORDER BY outbox.id`,
    [CLICKHOUSE_REPLAY_EVENT_TYPES],
  );
  return result.rows;
}

async function cloneRetainedRows(postgres, rebuildId, attemptId, maximumId, expectedCount) {
  if (maximumId === null) return 0;
  const keyPrefix = `fresh-rebuild:${rebuildId}:${attemptId}:`;
  const result = await postgres.query(
    `INSERT INTO pipeline_outbox (
       application_id, aggregate_type, aggregate_id, event_type, payload_json, status,
       idempotency_key, replay_of_outbox_id, attempt_count, available_at, updated_at
     )
     SELECT application_id, aggregate_type, aggregate_id, event_type, payload_json, 'pending',
            $1 || id::text, COALESCE(replay_of_outbox_id, id),
            0, statement_timestamp(), statement_timestamp()
     FROM pipeline_outbox
     WHERE id <= $2::bigint
       AND status = 'sent'
       AND event_type = ANY($3::text[])
       AND idempotency_key NOT LIKE 'fresh-rebuild:%'
       AND idempotency_key NOT LIKE 'reconciliation:%'
     ORDER BY id
     ON CONFLICT (application_id, idempotency_key) DO NOTHING
     RETURNING id::text`,
    [keyPrefix, maximumId, CLICKHOUSE_REPLAY_EVENT_TYPES],
  );
  if (result.rowCount !== expectedCount) {
    throw new Error(
      `retained Outbox replay clone count changed (${String(result.rowCount)}/${String(expectedCount)})`,
    );
  }
  return result.rowCount;
}

async function waitForReplay(postgres, keyPrefix, expectedCount, timeoutMs) {
  if (expectedCount === 0) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await postgres.query(
      `SELECT status::text, count(*)::integer AS count
       FROM pipeline_outbox
       WHERE idempotency_key LIKE $1
       GROUP BY status`,
      [`${keyPrefix}%`],
    );
    const statuses = Object.fromEntries(result.rows.map((row) => [row.status, row.count]));
    if ((statuses.dead_letter ?? 0) > 0) {
      throw new Error("a retained Outbox replay record entered the dead-letter queue");
    }
    if ((statuses.sent ?? 0) === expectedCount) return;
    await sleep(500);
  }
  throw new Error("retained PostgreSQL Outbox replay did not finish");
}

async function verifySchemaObjects(clickhouse) {
  const objects = await listDatabaseObjects(clickhouse);
  const names = new Set(objects.map((object) => object.name));
  for (const view of CURRENT_PROJECTION_VIEWS) {
    if (!names.has(view)) throw new Error(`current ClickHouse schema is missing ${view}`);
  }
  if (objects.some((object) => object.name.includes("__forward__"))) {
    throw new Error("fresh ClickHouse schema retained a shadow forwarding object");
  }
  return objects.length;
}

export async function runFreshRebuild(options, dependencies) {
  const { clickhouse, postgres, redis, migrateCurrentSchema } = dependencies;
  const plan = validateFreshPlan(options.plan, clickhouse.database);
  const startedAt = new Date().toISOString();
  const token = `${plan.rebuildId}:${randomUUID()}`;
  const attemptId = randomUUID().replaceAll("-", "").slice(0, 12);
  const keyPrefix = `fresh-rebuild:${plan.rebuildId}:${attemptId}:`;
  let lockHeld = false;
  let pauseHeld = false;
  let resetStarted = false;
  let schemaReady = false;
  let deliveryPaused = false;
  let droppedObjects = [];
  let retained = [];
  try {
    const ownerKey = `clickhouse:fresh-rebuild:owner:${plan.database}`;
    validateFreshTarget(options.environment, plan.database, await redis.get(ownerKey));
    await acquireKey(redis, rebuildLockKey, token);
    lockHeld = true;
    await acquireKey(redis, pauseKey, token);
    pauseHeld = true;
    deliveryPaused = true;
    await waitForNoLeases(postgres, options.timeoutMs);

    retained = await retainedRows(postgres);
    const expectedRows = expectedProjectionRows(retained);
    const expectedDeliveryIds = expectedProjectionDeliveryIds(retained);
    for (const [table, count] of Object.entries(expectedRows)) {
      if (expectedDeliveryIds[table].length !== count) {
        throw new Error(`retained Outbox identity count does not match ${table}`);
      }
    }
    const maximumId = retained.at(-1)?.id ?? null;
    const inputChecksum = retainedInputChecksum(retained);

    resetStarted = true;
    droppedObjects = await dropDatabaseObjects(clickhouse);
    await migrateCurrentSchema("up");
    await migrateCurrentSchema("verify");
    schemaReady = true;
    const objectCount = await verifySchemaObjects(clickhouse);
    const emptyCounts = await projectionCounts(clickhouse);
    if (Object.values(emptyCounts).some((count) => count !== 0)) {
      throw new Error("fresh ClickHouse schema was not empty before retained-input replay");
    }

    const replayedOutboxRows = await cloneRetainedRows(
      postgres,
      plan.rebuildId,
      attemptId,
      maximumId,
      retained.length,
    );
    await releaseKey(redis, pauseKey, token);
    pauseHeld = false;
    deliveryPaused = false;
    await waitForReplay(postgres, keyPrefix, retained.length, options.timeoutMs);
    pauseHeld = await ensurePaused(redis, token);
    deliveryPaused = true;
    await waitForNoLeases(postgres, options.timeoutMs);
    const actualRows = await waitForProjectionCounts(clickhouse, expectedRows, options.timeoutMs);
    const deliveryIdentities = await verifyProjectionDeliveryIds(clickhouse, expectedDeliveryIds);
    const aggregateSummaries = await waitForAggregateSemantics(clickhouse, options.timeoutMs);
    await migrateCurrentSchema("verify");
    if (pauseHeld) await releaseKey(redis, pauseKey, token);
    pauseHeld = false;
    deliveryPaused = false;

    const evidence = {
      release: "0.2.0",
      status: "passed",
      mode: "fresh_only",
      rebuild_id: plan.rebuildId,
      database: plan.database,
      actor: options.actor,
      reason: options.reason,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      schema_conflict_action: "clear_and_create_current_schema",
      retained_input_source: "postgresql.pipeline_outbox",
      retained_input_count: retained.length,
      retained_input_sha256: inputChecksum,
      replayed_outbox_count: replayedOutboxRows,
      expected_projection_rows: expectedRows,
      actual_projection_rows: actualRows,
      projection_delivery_identities: deliveryIdentities,
      projection_identity_difference_count: 0,
      aggregate_semantic_summaries: aggregateSummaries,
      aggregate_semantic_difference_count: 0,
      dropped_object_count: droppedObjects.length,
      current_schema_object_count: objectCount,
      historical_schema_retained: false,
      ownership_marker_verified: true,
      delivery_paused: false,
      usage_authority: "postgresql",
    };
    const evidencePath = await writePrivateJson(options.evidence, evidence);
    return { evidence, evidencePath };
  } catch (error) {
    let recoveryError;
    let pauseError;
    if (resetStarted) {
      try {
        await ensurePaused(redis, token);
        deliveryPaused = true;
        await waitForNoLeases(postgres, options.timeoutMs);
      } catch (candidate) {
        pauseError = candidate instanceof Error ? candidate.message : "delivery pause failed";
        deliveryPaused = (await redis.get(pauseKey)) !== null;
      }
    }
    if (pauseHeld && !schemaReady) {
      try {
        await dropDatabaseObjects(clickhouse);
        await migrateCurrentSchema("up");
        await migrateCurrentSchema("verify");
        schemaReady = true;
      } catch (candidate) {
        recoveryError =
          candidate instanceof Error ? candidate.message : "current-schema recovery failed";
      }
    }
    if (pauseHeld && schemaReady) {
      try {
        await releaseKey(redis, pauseKey, token);
        pauseHeld = false;
        deliveryPaused = false;
      } catch (candidate) {
        pauseError ??=
          candidate instanceof Error ? candidate.message : "delivery pause release failed";
        deliveryPaused = (await redis.get(pauseKey)) !== null;
      }
    }
    await writePrivateJson(options.evidence, {
      release: "0.2.0",
      status: "failed",
      mode: "fresh_only",
      rebuild_id: plan.rebuildId,
      database: plan.database,
      started_at: startedAt,
      failed_at: new Date().toISOString(),
      dropped_object_count: droppedObjects.length,
      retained_input_count: retained.length,
      current_schema_recovered: schemaReady,
      delivery_paused: deliveryPaused,
      ...(pauseError === undefined ? {} : { delivery_pause_error: pauseError }),
      ...(recoveryError === undefined ? {} : { recovery_error: recoveryError }),
      error: error instanceof Error ? error.message : "fresh ClickHouse rebuild failed",
    });
    throw error;
  } finally {
    if (lockHeld) await releaseKey(redis, rebuildLockKey, token);
  }
}

async function loadDefaultDependencies() {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (databaseUrl === undefined || redisUrl === undefined) {
    throw new TypeError("DATABASE_URL and REDIS_URL are required");
  }
  const databaseRequire = createRequire(resolve(root, "packages/db/package.json"));
  const workerRequire = createRequire(resolve(root, "apps/worker/package.json"));
  const { Client } = databaseRequire("pg");
  const RedisModule = workerRequire("ioredis");
  const Redis = RedisModule.default ?? RedisModule;
  const postgres = new Client({
    connectionString: databaseUrl,
    application_name: "clickhouse-fresh-rebuild",
  });
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: null,
  });
  await postgres.connect();
  try {
    await redis.connect();
    await redis.ping();
  } catch (error) {
    redis.disconnect(false);
    await postgres.end();
    throw error;
  }
  const migrationCli = resolve(root, "packages/clickhouse/dist/cli.js");
  return {
    clickhouse: createClickHouseClient(),
    postgres,
    redis,
    migrateCurrentSchema: async (command) => {
      await executeFile(process.execPath, [migrationCli, command], {
        cwd: root,
        env: process.env,
        encoding: "utf8",
        timeout: 15 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    },
    close: async () => {
      redis.disconnect(false);
      await postgres.end();
    },
  };
}

async function main() {
  const values = parseArguments(process.argv.slice(2));
  const { readFile } = await import("node:fs/promises");
  const plan = JSON.parse(await readFile(values.plan, "utf8"));
  const dependencies = await loadDefaultDependencies();
  try {
    const result = await runFreshRebuild(
      { ...values, plan, timeoutMs: 15 * 60_000, environment: process.env },
      dependencies,
    );
    process.stdout.write(
      `${JSON.stringify({
        status: "passed",
        mode: "fresh_only",
        rebuild_id: result.evidence.rebuild_id,
        replayed_outbox_count: result.evidence.replayed_outbox_count,
        evidence: result.evidencePath,
      })}\n`,
    );
  } finally {
    await dependencies.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "fresh ClickHouse rebuild failed"}\n`,
    );
    process.exitCode = 1;
  });
}

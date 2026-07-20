import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  requeueExpiredClickHouseLeases,
  runFreshRebuild,
} from "../../release/clickhouse-fresh-rebuild.mjs";

import {
  CLICKHOUSE_REPLAY_EVENT_TYPES,
  CURRENT_PROJECTION_TABLES,
  deliveryIdChecksum,
  dropDatabaseObjects,
  expectedProjectionDeliveryIds,
  expectedProjectionRows,
  identifier,
  retainedInputChecksum,
  validateFreshPlan,
  validateFreshTarget,
} from "../../release/lib/clickhouse-fresh-rebuild.mjs";
import {
  waitForAggregateSemantics,
  waitForProjectionCounts,
} from "../../release/lib/clickhouse-fresh-verification.mjs";

const freshRebuildSource = await readFile(
  new URL("../../release/clickhouse-fresh-rebuild.mjs", import.meta.url),
  "utf8",
);

const rebuildId = "d4f14052-7237-4e0c-8619-392140c124a4";
const applicationId = "a8831b1e-cd42-49c5-b90f-b3a4b1abc54c";
const database = "ai_control_acceptance_20260717010101abc123";
const plan = {
  rebuildId,
  database,
  steps: [
    "clear_isolated_database",
    "create_current_schema",
    "replay_postgresql_outbox",
    "verify_current_projection",
  ],
};

test("fresh plan is exact and tied to the configured database", () => {
  assert.deepEqual(validateFreshPlan(plan, database), plan);
  assert.throws(
    () => validateFreshPlan({ ...plan, database: `${database}_other` }, database),
    /current database contract/u,
  );
  assert.throws(
    () => validateFreshPlan({ ...plan, previousTable: "usage_events_raw_old" }, database),
    /current database contract/u,
  );
});

test("retained Outbox rows are ordered by their numeric database identity", () => {
  assert.match(freshRebuildSource, /ORDER BY outbox\.id/u);
  assert.doesNotMatch(freshRebuildSource, /SELECT id::text[\s\S]*ORDER BY id/u);
});

test("fresh replay preserves application ownership and uses its scoped idempotency key", () => {
  assert.match(freshRebuildSource, /SELECT outbox\.id::text, outbox\.application_id::text/u);
  assert.match(
    freshRebuildSource,
    /INSERT INTO pipeline_outbox \([\s\S]*application_id,[\s\S]*SELECT application_id,/u,
  );
  assert.match(freshRebuildSource, /ON CONFLICT \(application_id, idempotency_key\) DO NOTHING/u);
});

test("fresh rebuild requeues only expired ClickHouse delivery leases", async () => {
  const calls = [];
  const rows = [{ id: "41" }, { id: "42" }];
  const changed = await requeueExpiredClickHouseLeases({
    query: async (query, values) => {
      calls.push({ query, values });
      if (query.includes("RETURNING id::text")) return { rowCount: 2, rows };
      if (query.includes("SET status = 'failed'")) return { rowCount: 2, rows: [] };
      return { rowCount: 0, rows: [] };
    },
  });
  assert.equal(changed, 2);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].query, "BEGIN");
  assert.match(calls[1].query, /status = 'leased'/u);
  assert.match(calls[1].query, /lease_expires_at <= statement_timestamp\(\)/u);
  assert.match(calls[1].query, /attempt_count = attempt_count \+ 1/u);
  assert.match(calls[1].query, /event_type = ANY\(\$1::text\[\]\)/u);
  assert.deepEqual(calls[1].values?.[0], CLICKHOUSE_REPLAY_EVENT_TYPES);
  assert.match(calls[1].values?.[1], /^fresh-rebuild-recovery:/u);
  assert.match(calls[2].query, /SET status = 'failed'/u);
  assert.deepEqual(calls[2].values, [rows.map((row) => row.id), calls[1].values?.[1]]);
  assert.equal(calls[3].query, "COMMIT");
});

test("fresh target refuses production, missing allow, and missing ownership", () => {
  const environment = {
    CLICKHOUSE_FRESH_REBUILD_ALLOWED: "true",
    CLICKHOUSE_FRESH_REBUILD_OWNER: "acceptance:20260717010101-123-abcdef",
  };
  assert.deepEqual(
    validateFreshTarget(environment, database, environment.CLICKHOUSE_FRESH_REBUILD_OWNER),
    { database, ownerVerified: true },
  );
  assert.throws(
    () =>
      validateFreshTarget(
        environment,
        "ai_control_plane",
        environment.CLICKHOUSE_FRESH_REBUILD_OWNER,
      ),
    /disposable non-production/u,
  );
  assert.throws(
    () =>
      validateFreshTarget(
        { ...environment, CLICKHOUSE_FRESH_REBUILD_ALLOWED: "false" },
        database,
        environment.CLICKHOUSE_FRESH_REBUILD_OWNER,
      ),
    /not explicitly allowed/u,
  );
  assert.throws(() => validateFreshTarget(environment, database, null), /ownership marker/u);
});

test("retained Outbox payloads deterministically predict every base projection row", () => {
  const rows = [
    { id: "1", application_id: applicationId, event_type: "usage_events_raw", payload_json: {} },
    {
      id: "2",
      application_id: applicationId,
      event_type: "usage_lines",
      payload_json: { normalized: { usage_lines: [{}, {}] } },
    },
    {
      id: "3",
      application_id: applicationId,
      event_type: "provider_cost.official_delta",
      payload_json: { deltas: [{}, {}] },
    },
    {
      id: "4",
      application_id: applicationId,
      event_type: "aiu.official_delta",
      payload_json: { deltas: [{ lines: [] }, { lines: [{}, {}, {}] }] },
    },
    {
      id: "7",
      application_id: applicationId,
      event_type: "provider_cost.unpriced",
      payload_json: { deltas: [{}] },
    },
    {
      id: "8",
      application_id: applicationId,
      event_type: "aiu.decision",
      payload_json: { deltas: [{ lines: [] }] },
    },
    {
      id: "9",
      application_id: applicationId,
      event_type: "application_user.profile",
      payload_json: { user_id: "user-42" },
    },
    {
      id: "10",
      application_id: applicationId,
      event_type: "application_user.profile",
      payload_json: { user_id: "user-42" },
    },
  ];
  assert.deepEqual(expectedProjectionRows(rows), {
    usage_events_raw: 1,
    usage_lines: 2,
    rating_events: 8,
    application_user_profiles: 1,
  });
  assert.match(retainedInputChecksum(rows), /^[0-9a-f]{64}$/u);
  const deliveryIds = expectedProjectionDeliveryIds(rows);
  assert.deepEqual(deliveryIds, {
    usage_events_raw: ["outbox:1:raw"],
    usage_lines: ["outbox:2:usage:0", "outbox:2:usage:1"],
    rating_events: [
      "outbox:3:provider-rating:0",
      "outbox:3:provider-rating:1",
      "outbox:4:aiu-rating:0:0",
      "outbox:4:aiu-rating:1:0",
      "outbox:4:aiu-rating:1:1",
      "outbox:4:aiu-rating:1:2",
      "outbox:7:provider-rating:0",
      "outbox:8:aiu-rating:0:0",
    ],
    application_user_profiles: ["outbox:10:user-profile"],
  });
  assert.match(deliveryIdChecksum(deliveryIds.rating_events), /^[0-9a-f]{64}$/u);
});

test("fresh replay delivery identities remain bound to the original Outbox row", () => {
  assert.deepEqual(
    expectedProjectionDeliveryIds([
      {
        id: "100",
        application_id: applicationId,
        replay_of_outbox_id: "10",
        event_type: "usage_events_raw",
        payload_json: {},
      },
    ]).usage_events_raw,
    ["outbox:10:raw"],
  );
  assert.throws(
    () =>
      expectedProjectionDeliveryIds([
        {
          id: "100",
          application_id: applicationId,
          replay_of_outbox_id: "100",
          event_type: "usage_events_raw",
          payload_json: {},
        },
      ]),
    /invalid replay identity/u,
  );
});

test("database reset drops views before tables and proves the schema is empty", async () => {
  const statements = [];
  let listing = 0;
  const client = {
    database,
    execute: async (query) => {
      statements.push(query);
      if (query.includes("FROM system.tables")) {
        listing += 1;
        return listing === 1
          ? '{"name":"current_usage_events_raw","engine":"View"}\n{"name":"usage_events_raw","engine":"MergeTree"}\n'
          : "";
      }
      return "";
    },
  };
  const dropped = await dropDatabaseObjects(client);
  assert.equal(dropped.length, 2);
  assert.match(statements[1], /^DROP VIEW/u);
  assert.match(statements[2], /^DROP TABLE/u);
  assert.throws(() => identifier("bad-name"), /safe identifier/u);
  assert.deepEqual(CURRENT_PROJECTION_TABLES, [
    "usage_events_raw",
    "usage_lines",
    "rating_events",
    "application_user_profiles",
  ]);
});

test("fresh projection verification requires exact physical and current counts", async () => {
  const exact = {
    database,
    execute: async () => '{"row_count":"1"}\n',
  };
  assert.deepEqual(await waitForProjectionCounts(exact, { usage_events_raw: 1 }, 100), {
    usage_events_raw: 1,
  });
  await assert.rejects(
    waitForProjectionCounts(
      { ...exact, execute: async () => '{"row_count":"2"}\n' },
      { usage_events_raw: 1 },
      100,
    ),
    /exceeded retained-input counts/u,
  );
});

test("fresh aggregate verification compares every rollup with base facts", async () => {
  const summary = Object.fromEntries(
    [
      "request_count",
      "attempt_count",
      "success_count",
      "error_count",
      "usage_quantity",
      "latency_sum_ms",
      "latency_sample_count",
      "provisional_provider_cost",
      "official_provider_cost_delta",
      "provisional_aiu_micros",
      "official_aiu_micros_delta",
      "unpriced_count",
      "unrated_count",
      "fallback_count",
    ].map((metric) => [metric, "0"]),
  );
  const queries = [];
  const clickhouse = {
    database,
    execute: async (query) => {
      queries.push(query);
      return `${JSON.stringify(summary)}\n`;
    },
  };
  const result = await waitForAggregateSemantics(clickhouse, 100);
  assert.deepEqual(result.base_facts, summary);
  assert.deepEqual(result.one_minute, summary);
  assert.deepEqual(result.hourly, summary);
  assert.deepEqual(result.daily, summary);
  assert.equal(queries.length, 4);
  assert.ok(queries.some((query) => query.includes("current_usage_agg_1m")));
  assert.ok(queries.some((query) => query.includes("current_usage_agg_hourly")));
  assert.ok(queries.some((query) => query.includes("current_usage_agg_daily")));
  const baseFactQuery = queries.find(
    (query) =>
      query.includes("current_rating_events") && query.includes("current_usage_events_raw"),
  );
  assert.match(
    baseFactQuery,
    /sumIf\([\s\S]*rating_stage IN \('unpriced', 'invalid_usage'\)[\s\S]*AS unpriced_count/u,
  );
  assert.match(
    baseFactQuery,
    /sumIf\([\s\S]*rating_stage IN \('unrated', 'invalid_usage'\)[\s\S]*AS unrated_count/u,
  );
  assert.doesNotMatch(baseFactQuery, /countIf\([^)]*(?:amount_decimal|aiu_micros) IS NULL/u);
});

test("a failure after schema reset keeps delivery paused for operator recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clickhouse-fresh-failure-"));
  const evidencePath = join(directory, "failure.json");
  const owner = "acceptance:20260717010101-123-abcdef";
  const values = new Map([[`clickhouse:fresh-rebuild:owner:${database}`, owner]]);
  const redis = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      if (values.has(key)) return null;
      values.set(key, value);
      return "OK";
    },
    eval: async (_script, _count, key, token) => {
      if (values.get(key) !== token) return 0;
      values.delete(key);
      return 1;
    },
  };
  let objects = [{ name: "obsolete_schema", engine: "MergeTree" }];
  const clickhouse = {
    database,
    execute: async (query) => {
      if (query.includes("FROM system.tables")) {
        return objects.map((object) => JSON.stringify(object)).join("\n");
      }
      if (query.startsWith("DROP ")) objects = [];
      return "";
    },
  };
  const postgres = {
    query: async (query) =>
      query.includes("count(*)::integer") ? { rows: [{ count: 0 }] } : { rows: [] },
  };
  try {
    await assert.rejects(
      runFreshRebuild(
        {
          plan,
          actor: "acceptance-runner",
          reason: "exercise fail-closed current-schema recovery",
          evidence: evidencePath,
          timeoutMs: 1_000,
          environment: {
            CLICKHOUSE_FRESH_REBUILD_ALLOWED: "true",
            CLICKHOUSE_FRESH_REBUILD_OWNER: owner,
          },
        },
        {
          clickhouse,
          postgres,
          redis,
          migrateCurrentSchema: async () => {
            throw new Error("simulated current-schema creation failure");
          },
        },
      ),
      /simulated current-schema creation failure/u,
    );
    assert.ok(values.has("clickhouse:sink:pause"));
    assert.ok(!values.has("clickhouse:fresh-rebuild:lock"));
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.delivery_paused, true);
    assert.equal(evidence.current_schema_recovered, false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("a foreign pause owner turns verification into a fail-closed conflict", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clickhouse-fresh-foreign-pause-"));
  const evidencePath = join(directory, "failure.json");
  const owner = "acceptance:20260717010101-123-abcdef";
  const ownerKey = `clickhouse:fresh-rebuild:owner:${database}`;
  const values = new Map([[ownerKey, owner]]);
  const redis = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      if (values.has(key)) return null;
      values.set(key, value);
      return "OK";
    },
    eval: async (_script, _count, key, token) => {
      if (values.get(key) !== token) return 0;
      values.delete(key);
      if (key === "clickhouse:sink:pause") values.set(key, "foreign-operator-token");
      return 1;
    },
  };
  let objects = [{ name: "obsolete_schema", engine: "MergeTree" }];
  const clickhouse = {
    database,
    execute: async (query) => {
      if (query.includes("FROM system.tables")) {
        return objects.map((object) => JSON.stringify(object)).join("\n");
      }
      if (query.startsWith("DROP ")) objects = [];
      if (
        query.includes("toString(count()) AS row_count") ||
        query.includes("toString(uniqExact(tuple(application_id, user_id))) AS row_count")
      ) {
        return '{"row_count":"0"}\n';
      }
      return "";
    },
  };
  const postgres = {
    query: async (query) =>
      query.includes("count(*)::integer") ? { rows: [{ count: 0 }] } : { rows: [] },
  };
  try {
    await assert.rejects(
      runFreshRebuild(
        {
          plan,
          actor: "acceptance-runner",
          reason: "exercise foreign delivery-pause ownership",
          evidence: evidencePath,
          timeoutMs: 1_000,
          environment: {
            CLICKHOUSE_FRESH_REBUILD_ALLOWED: "true",
            CLICKHOUSE_FRESH_REBUILD_OWNER: owner,
          },
        },
        {
          clickhouse,
          postgres,
          redis,
          migrateCurrentSchema: async (command) => {
            if (command === "up") {
              objects = CURRENT_PROJECTION_TABLES.map((table) => ({
                name: `current_${table}`,
                engine: "View",
              }));
            }
          },
        },
      ),
      /pause is held by another owner/u,
    );
    assert.equal(values.get("clickhouse:sink:pause"), "foreign-operator-token");
    assert.ok(!values.has("clickhouse:fresh-rebuild:lock"));
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    assert.equal(evidence.delivery_paused, true);
    assert.match(evidence.delivery_pause_error, /another owner/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

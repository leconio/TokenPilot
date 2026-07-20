import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const CLICKHOUSE_REPLAY_EVENT_TYPES = Object.freeze([
  "usage_events_raw",
  "usage_lines",
  "provider_cost.provisional",
  "provider_cost.official_delta",
  "provider_cost.adjustment",
  "provider_cost.unpriced",
  "aiu.provisional",
  "aiu.official_delta",
  "aiu.decision",
  "application_user.profile",
]);

export const CURRENT_PROJECTION_TABLES = Object.freeze([
  "usage_events_raw",
  "usage_lines",
  "rating_events",
  "application_user_profiles",
]);

export const CURRENT_PROJECTION_VIEWS = Object.freeze(
  CURRENT_PROJECTION_TABLES.map((table) => `current_${table}`),
);

const identifierPattern = /^[a-zA-Z_][a-zA-Z0-9_]{0,254}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const disposableDatabasePattern = /^ai_control_(?:acceptance|development|test)_[a-z0-9_]{6,180}$/u;
const ownerPattern = /^[A-Za-z0-9._:-]{16,180}$/u;

export function identifier(value, label = "identifier") {
  if (!identifierPattern.test(value)) throw new TypeError(`${label} is not a safe identifier`);
  return `\`${value}\``;
}

export function sqlString(value, label = "value") {
  const containsControlCharacter =
    typeof value === "string" &&
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    });
  if (typeof value !== "string" || containsControlCharacter) {
    throw new TypeError(`${label} contains unsupported control characters`);
  }
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

export function validateFreshPlan(plan, database) {
  const expectedSteps = [
    "clear_isolated_database",
    "create_current_schema",
    "replay_postgresql_outbox",
    "verify_current_projection",
  ];
  if (
    plan === null ||
    typeof plan !== "object" ||
    Array.isArray(plan) ||
    typeof plan.rebuildId !== "string" ||
    !uuidPattern.test(plan.rebuildId) ||
    plan.database !== database ||
    !Array.isArray(plan.steps) ||
    JSON.stringify(plan.steps) !== JSON.stringify(expectedSteps) ||
    Object.keys(plan).sort().join(",") !== "database,rebuildId,steps"
  ) {
    throw new TypeError("fresh rebuild plan does not match the current database contract");
  }
  identifier(database, "ClickHouse database");
  return Object.freeze({ rebuildId: plan.rebuildId, database, steps: expectedSteps });
}

export function validateFreshTarget(environment, database, storedOwner) {
  const configuredOwner = environment.CLICKHOUSE_FRESH_REBUILD_OWNER;
  if (environment.CLICKHOUSE_FRESH_REBUILD_ALLOWED !== "true") {
    throw new Error("fresh ClickHouse rebuild is not explicitly allowed for this runtime");
  }
  if (!disposableDatabasePattern.test(database)) {
    throw new Error("fresh ClickHouse rebuild requires a disposable non-production database name");
  }
  if (
    configuredOwner === undefined ||
    !ownerPattern.test(configuredOwner) ||
    storedOwner !== configuredOwner
  ) {
    throw new Error("fresh ClickHouse rebuild ownership marker is missing or does not match");
  }
  return Object.freeze({ database, ownerVerified: true });
}

export function createClickHouseClient(environment = process.env, fetchImplementation = fetch) {
  const rawUrl = environment.CLICKHOUSE_URL;
  const database = environment.CLICKHOUSE_DATABASE;
  const username = environment.CLICKHOUSE_MIGRATION_USERNAME;
  const password = environment.CLICKHOUSE_MIGRATION_PASSWORD;
  if (
    rawUrl === undefined ||
    database === undefined ||
    username === undefined ||
    password === undefined
  ) {
    throw new TypeError(
      "CLICKHOUSE_URL, CLICKHOUSE_DATABASE, CLICKHOUSE_MIGRATION_USERNAME, and CLICKHOUSE_MIGRATION_PASSWORD are required",
    );
  }
  const baseUrl = new URL(rawUrl);
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new TypeError("CLICKHOUSE_URL must be credential-free HTTP or HTTPS");
  }
  identifier(database, "ClickHouse database");
  identifier(username, "ClickHouse migration username");
  if (password.length < 16) throw new TypeError("ClickHouse migration password is invalid");
  const timeout = Number(environment.CLICKHOUSE_REQUEST_TIMEOUT_MS ?? 120_000);
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 900_000) {
    throw new TypeError("CLICKHOUSE_REQUEST_TIMEOUT_MS is invalid");
  }

  async function execute(query) {
    const endpoint = new URL(baseUrl);
    endpoint.searchParams.set("database", database);
    const response = await fetchImplementation(endpoint, {
      method: "POST",
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-clickhouse-user": username,
        "x-clickhouse-key": password,
      },
      body: query,
      signal: AbortSignal.timeout(timeout),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `ClickHouse query failed with HTTP ${response.status}: ${body.slice(0, 500)}`,
      );
    }
    return body;
  }

  return Object.freeze({ database, execute });
}

export function parseJsonEachRow(body) {
  return body
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

export async function queryJsonRows(client, query) {
  return parseJsonEachRow(await client.execute(`${query}\nFORMAT JSONEachRow`));
}

export function expectedProjectionRows(outboxRows) {
  const counts = Object.fromEntries(CURRENT_PROJECTION_TABLES.map((table) => [table, 0]));
  const applicationUsers = new Set();
  for (const row of outboxRows) {
    const payload = row.payload_json;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TypeError(`retained Outbox ${String(row.id)} has no object payload`);
    }
    if (row.event_type === "usage_events_raw") counts.usage_events_raw += 1;
    else if (row.event_type === "usage_lines") {
      const lines = payload.normalized?.usage_lines;
      if (!Array.isArray(lines)) throw new TypeError("retained usage-lines payload is invalid");
      counts.usage_lines += lines.length;
    } else if (
      row.event_type === "provider_cost.provisional" ||
      row.event_type === "provider_cost.official_delta" ||
      row.event_type === "provider_cost.adjustment" ||
      row.event_type === "provider_cost.unpriced"
    ) {
      if (!Array.isArray(payload.deltas))
        throw new TypeError("retained Provider Cost payload is invalid");
      counts.rating_events += payload.deltas.length;
    } else if (
      row.event_type === "aiu.provisional" ||
      row.event_type === "aiu.official_delta" ||
      row.event_type === "aiu.decision"
    ) {
      if (!Array.isArray(payload.deltas)) throw new TypeError("retained AIU payload is invalid");
      for (const delta of payload.deltas) {
        if (delta === null || typeof delta !== "object" || Array.isArray(delta)) {
          throw new TypeError("retained AIU delta is invalid");
        }
        if (!Array.isArray(delta.lines)) throw new TypeError("retained AIU lines are invalid");
        counts.rating_events += Math.max(1, delta.lines.length);
      }
    } else if (row.event_type === "application_user.profile") {
      const userId = payload.user_id;
      if (typeof userId !== "string" || userId.length === 0) {
        throw new TypeError("retained application-user profile payload is invalid");
      }
      applicationUsers.add(`${row.application_id}\0${userId}`);
    }
  }
  counts.application_user_profiles = applicationUsers.size;
  return Object.freeze(counts);
}

function outboxSourceId(row) {
  const id = BigInt(row.id);
  const replay =
    row.replay_of_outbox_id === null || row.replay_of_outbox_id === undefined
      ? null
      : BigInt(row.replay_of_outbox_id);
  const source = replay ?? id;
  if (id < 1n || source < 1n || (replay !== null && source >= id)) {
    throw new TypeError(`retained Outbox ${String(row.id)} has an invalid replay identity`);
  }
  return source.toString();
}

export function expectedProjectionDeliveryIds(outboxRows) {
  const ids = Object.fromEntries(CURRENT_PROJECTION_TABLES.map((table) => [table, []]));
  const append = (table, source, suffix) => ids[table].push(`outbox:${source}:${suffix}`);
  const latestApplicationUsers = new Map();
  for (const row of outboxRows) {
    const payload = row.payload_json;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TypeError(`retained Outbox ${String(row.id)} has no object payload`);
    }
    const source = outboxSourceId(row);
    if (row.event_type === "usage_events_raw") append("usage_events_raw", source, "raw");
    else if (row.event_type === "usage_lines") {
      const lines = payload.normalized?.usage_lines;
      if (!Array.isArray(lines)) throw new TypeError("retained usage-lines payload is invalid");
      for (const index of lines.keys()) append("usage_lines", source, `usage:${index}`);
    } else if (
      row.event_type === "provider_cost.provisional" ||
      row.event_type === "provider_cost.official_delta" ||
      row.event_type === "provider_cost.adjustment" ||
      row.event_type === "provider_cost.unpriced"
    ) {
      if (!Array.isArray(payload.deltas)) {
        throw new TypeError("retained Provider Cost payload is invalid");
      }
      for (const index of payload.deltas.keys()) {
        append("rating_events", source, `provider-rating:${index}`);
      }
    } else if (
      row.event_type === "aiu.provisional" ||
      row.event_type === "aiu.official_delta" ||
      row.event_type === "aiu.decision"
    ) {
      if (!Array.isArray(payload.deltas)) throw new TypeError("retained AIU payload is invalid");
      for (const [deltaIndex, delta] of payload.deltas.entries()) {
        if (delta === null || typeof delta !== "object" || Array.isArray(delta)) {
          throw new TypeError("retained AIU delta is invalid");
        }
        if (!Array.isArray(delta.lines)) throw new TypeError("retained AIU lines are invalid");
        const count = Math.max(1, delta.lines.length);
        for (let lineIndex = 0; lineIndex < count; lineIndex += 1) {
          append("rating_events", source, `aiu-rating:${deltaIndex}:${lineIndex}`);
        }
      }
    } else if (row.event_type === "application_user.profile") {
      const userId = payload.user_id;
      if (typeof userId !== "string" || userId.length === 0) {
        throw new TypeError("retained application-user profile payload is invalid");
      }
      const key = `${row.application_id}\0${userId}`;
      const previous = latestApplicationUsers.get(key);
      if (previous === undefined || BigInt(source) > BigInt(previous)) {
        latestApplicationUsers.set(key, source);
      }
    }
  }
  ids.application_user_profiles.push(
    ...[...latestApplicationUsers.values()].map((source) => `outbox:${source}:user-profile`),
  );
  for (const [table, values] of Object.entries(ids)) {
    values.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    if (new Set(values).size !== values.length) {
      throw new Error(`retained PostgreSQL Outbox has duplicate ${table} delivery identities`);
    }
    Object.freeze(values);
  }
  return Object.freeze(ids);
}

export function deliveryIdChecksum(ids) {
  const hash = createHash("sha256");
  for (const id of ids) hash.update(`${id}\n`);
  return hash.digest("hex");
}

export function retainedInputChecksum(outboxRows) {
  const hash = createHash("sha256");
  for (const row of outboxRows) {
    if (typeof row.application_id !== "string" || !uuidPattern.test(row.application_id)) {
      throw new TypeError(`retained Outbox ${String(row.id)} has no valid application identity`);
    }
    hash.update(row.application_id);
    hash.update("\0");
    hash.update(String(row.id));
    hash.update("\0");
    hash.update(String(row.event_type));
    hash.update("\0");
    hash.update(JSON.stringify(row.payload_json));
    hash.update("\n");
  }
  return hash.digest("hex");
}

export async function listDatabaseObjects(client) {
  return queryJsonRows(
    client,
    `SELECT name, engine FROM system.tables WHERE database = ${sqlString(client.database)} ORDER BY name`,
  );
}

export async function dropDatabaseObjects(client) {
  const objects = await listDatabaseObjects(client);
  const priority = (engine) =>
    engine === "MaterializedView" || engine === "View" ? 0 : engine === "Dictionary" ? 1 : 2;
  for (const object of [...objects].sort(
    (left, right) => priority(left.engine) - priority(right.engine),
  )) {
    const kind =
      object.engine === "MaterializedView" || object.engine === "View"
        ? "VIEW"
        : object.engine === "Dictionary"
          ? "DICTIONARY"
          : "TABLE";
    await client.execute(
      `DROP ${kind} IF EXISTS ${identifier(client.database)}.${identifier(object.name, "database object")}`,
    );
  }
  const remaining = await listDatabaseObjects(client);
  if (remaining.length !== 0)
    throw new Error("ClickHouse database reset left schema objects behind");
  return objects;
}

export async function projectionCounts(client) {
  const result = {};
  for (const table of CURRENT_PROJECTION_TABLES) {
    const [physical] = await queryJsonRows(
      client,
      `SELECT toString(count()) AS row_count FROM ${identifier(client.database)}.${identifier(table)}`,
    );
    const [current] = await queryJsonRows(
      client,
      `SELECT toString(count()) AS row_count FROM ${identifier(client.database)}.${identifier(`current_${table}`)}`,
    );
    const expectedCurrentCount =
      table === "application_user_profiles"
        ? (
            await queryJsonRows(
              client,
              `SELECT toString(uniqExact(tuple(application_id, user_id))) AS row_count
               FROM ${identifier(client.database)}.${identifier(table)}`,
            )
          )[0]
        : physical;
    if (
      physical === undefined ||
      current === undefined ||
      expectedCurrentCount === undefined ||
      expectedCurrentCount.row_count !== current.row_count
    ) {
      throw new Error(`current ClickHouse projection does not match ${table}`);
    }
    result[table] = Number(
      table === "application_user_profiles" ? current.row_count : physical.row_count,
    );
    if (!Number.isSafeInteger(result[table]) || result[table] < 0) {
      throw new Error(`ClickHouse projection count is invalid for ${table}`);
    }
  }
  return Object.freeze(result);
}

export async function verifyProjectionDeliveryIds(client, expected) {
  const result = {};
  for (const table of CURRENT_PROJECTION_TABLES) {
    const rows = await queryJsonRows(
      client,
      table === "application_user_profiles"
        ? `SELECT
             argMax(sink_delivery_id, profile_version) AS sink_delivery_id,
             argMax(source_outbox_id, profile_version) AS source_outbox_id
           FROM ${identifier(client.database)}.${identifier(table)}
           GROUP BY application_id, user_id
           ORDER BY sink_delivery_id`
        : `SELECT sink_delivery_id, source_outbox_id
           FROM ${identifier(client.database)}.${identifier(table)}
           ORDER BY sink_delivery_id`,
    );
    const actual = rows.map((row) => {
      if (
        typeof row.sink_delivery_id !== "string" ||
        typeof row.source_outbox_id !== "string" ||
        !/^[1-9][0-9]*$/u.test(row.source_outbox_id)
      ) {
        throw new Error(`ClickHouse projection identity is invalid for ${table}`);
      }
      return row.sink_delivery_id;
    });
    if (new Set(actual).size !== actual.length) {
      throw new Error(`ClickHouse projection has duplicate ${table} delivery identities`);
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected[table])) {
      throw new Error(`ClickHouse projection delivery identities do not match ${table}`);
    }
    result[table] = Object.freeze({
      row_count: actual.length,
      delivery_id_sha256: deliveryIdChecksum(actual),
    });
  }
  return Object.freeze(result);
}

export async function writePrivateJson(path, document) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, absolute);
  return absolute;
}

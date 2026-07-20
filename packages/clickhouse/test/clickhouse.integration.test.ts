import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyClickHouseMigrations,
  checkClickHouseHealth,
  ClickHouseOperations,
  createClickHouseClient,
  discoverClickHouseMigrations,
  getClickHouseMigrationStatus,
  loadClickHouseConfig,
  verifyClickHouseMigrations,
  type ClickHouseClient,
  type ClickHouseRuntimeConfig,
} from "../src/index.js";

const integrationEnabled = process.env.CLICKHOUSE_INTEGRATION === "true";
const describeIntegration = integrationEnabled ? describe : describe.skip;

function randomIdentifier(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

async function expectAccessDenied(action: () => Promise<unknown>): Promise<void> {
  const error = await action().then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeDefined();
  expect(String((error as { code?: unknown }).code)).toBe("497");
  expect((error as Error).message).toMatch(/ACCESS_DENIED|Not enough privileges/iu);
}

async function checkGrant(client: ClickHouseClient, privilege: string): Promise<boolean> {
  // CHECK GRANT deliberately does not accept a FORMAT suffix. The official
  // client's query() API always appends one, so consume exec()'s raw stream.
  const result = await client.exec({ query: `CHECK GRANT ${privilege}` });
  let output = "";
  for await (const chunk of result.stream as AsyncIterable<Buffer | string>) {
    output += chunk.toString();
  }
  expect(output.trim()).toMatch(/^[01]$/u);
  return output.trim() === "1";
}

describeIntegration("ClickHouse remote integration", () => {
  let applicationClient: ClickHouseClient;
  let migrationClient: ClickHouseClient;
  let applicationConfig: ClickHouseRuntimeConfig;
  let migrationConfig: ClickHouseRuntimeConfig;
  const migrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));

  beforeAll(() => {
    migrationConfig = loadClickHouseConfig(process.env, {
      role: "migration",
    });
    applicationConfig = loadClickHouseConfig(process.env, {
      role: "application",
    });
    migrationClient = createClickHouseClient(migrationConfig);
    applicationClient = createClickHouseClient(applicationConfig);
  });

  afterAll(async () => {
    await Promise.allSettled([applicationClient?.close(), migrationClient?.close()]);
  });

  it("checks real health, applies immutable migrations, and enforces least privilege", async () => {
    const migrationHealth = await checkClickHouseHealth(migrationClient);
    expect(migrationHealth).toMatchObject({
      ok: true,
      version: "26.3.17.4",
      database: migrationConfig.database,
    });

    const migrations = await discoverClickHouseMigrations(migrationsDirectory);
    const statusBefore = await getClickHouseMigrationStatus(
      migrationClient,
      migrationConfig.database,
      migrations,
    );
    const expectedFirstRun = statusBefore.migrations
      .filter((migration) => migration.state === "pending")
      .map((migration) => migration.version);
    const firstRun = await applyClickHouseMigrations(
      migrationClient,
      migrationConfig.database,
      migrations,
    );
    expect(firstRun.appliedVersions).toEqual(expectedFirstRun);
    await expect(
      verifyClickHouseMigrations(migrationClient, migrationConfig.database, migrations),
    ).resolves.toMatchObject({
      migrationTableExists: true,
      migrations: expect.arrayContaining([
        expect.objectContaining({ version: 1, state: "applied" }),
        expect.objectContaining({ version: 23, state: "applied" }),
      ]),
    });

    const secondRun = await applyClickHouseMigrations(
      migrationClient,
      migrationConfig.database,
      migrations,
    );
    expect(secondRun.appliedVersions).toEqual([]);

    const applicationHealth = await checkClickHouseHealth(applicationClient);
    expect(applicationHealth).toMatchObject({
      ok: true,
      version: "26.3.17.4",
      database: migrationConfig.database,
    });

    await expectAccessDenied(() =>
      applicationClient.command({
        query: `CREATE TABLE ${migrationConfig.database}.${randomIdentifier("runtime_must_not_create")} (id UInt8) ENGINE = Memory`,
      }),
    );

    await expectAccessDenied(async () => {
      const result = await applicationClient.query({
        query: `SELECT count() FROM ${migrationConfig.database}.clickhouse_schema_migrations`,
        format: "JSONEachRow",
      });
      await result.json();
    });
    await expectAccessDenied(() =>
      applicationClient.insert({
        table: `${migrationConfig.database}.clickhouse_schema_migrations`,
        values: [
          {
            version: 9999,
            name: "forbidden",
            checksum: "f".repeat(64),
            execution_ms: 0,
          },
        ],
        format: "JSONEachRow",
      }),
    );

    const lockTable = `${migrationConfig.database}.__clickhouse_schema_migration_lock`;
    await migrationClient.command({
      query: `CREATE TABLE ${lockTable} (acquired_at DateTime64(3, 'UTC')) ENGINE = Memory`,
    });
    try {
      await expectAccessDenied(async () => {
        const result = await applicationClient.query({
          query: `SELECT count() FROM ${lockTable}`,
          format: "JSONEachRow",
        });
        await result.json();
      });
      await expectAccessDenied(() =>
        applicationClient.insert({
          table: lockTable,
          values: [{ acquired_at: "2026-07-16 00:00:00.000" }],
          format: "JSONEachRow",
        }),
      );
    } finally {
      await migrationClient.command({ query: `DROP TABLE ${lockTable}` });
    }

    const ddlTable = `${migrationConfig.database}.${randomIdentifier("migrator_ddl_probe")}`;
    await migrationClient.command({
      query: `CREATE TABLE ${ddlTable} (id UInt8) ENGINE = Memory`,
    });
    await migrationClient.command({ query: `ALTER TABLE ${ddlTable} ADD COLUMN marker UInt8` });
    await migrationClient.command({ query: `DROP TABLE ${ddlTable}` });

    await expectAccessDenied(() =>
      migrationClient.command({
        query: `CREATE DATABASE ${randomIdentifier("migration_must_not_create_database")}`,
      }),
    );
    await expectAccessDenied(() =>
      migrationClient.command({
        query: `CREATE USER ${randomIdentifier("migration_must_not_create_user")} IDENTIFIED WITH no_password`,
      }),
    );
    await expect(
      Promise.all([
        checkGrant(migrationClient, `DROP DATABASE ON ${migrationConfig.database}.*`),
        checkGrant(migrationClient, `ALTER DATABASE ON ${migrationConfig.database}.*`),
        checkGrant(migrationClient, "CREATE USER ON *.*"),
        checkGrant(migrationClient, "ALTER USER ON *.*"),
        checkGrant(migrationClient, "CREATE ROLE ON *.*"),
      ]),
    ).resolves.toEqual([false, false, false, false, false]);
  }, 30_000);

  it("confirms 10k batched events, deterministic MVs, signed corrections, TTL and query timeout", async () => {
    const operations = new ClickHouseOperations(applicationClient, applicationConfig);
    const instanceId = randomIdentifier("analytics_batch");
    const now = new Date();
    const eventTime = now.toISOString().replace("T", " ").replace("Z", "");
    const eventDate = now.toISOString().slice(0, 10);
    const rawRows = Array.from({ length: 10_000 }, (_, index) => ({
      application_id: "integration-application",
      instance_id: instanceId,
      environment: "integration",
      application_version: "integration",
      sdk_version: "integration",
      connector_version: "integration",
      config_version: "integration",
      event_date: eventDate,
      event_time: eventTime,
      received_at: eventTime,
      event_id: `${instanceId}-event-${index}`,
      schema_version: "2.0",
      request_id: `${instanceId}-request-${index}`,
      attempt_id: `${instanceId}-attempt-${index}`,
      operation_id: `${instanceId}-operation-${index}`,
      session_id: "integration-session",
      conversation_id: "integration-conversation",
      trace_id: `${instanceId}-trace-${index}`,
      user_id: "integration-user",
      display_user: "Integration User",
      virtual_model: "integration-model",
      model_id: "integration-model-id",
      request_model: "integration/model",
      provider: "integration-provider",
      status: "success",
      error_class: "",
      http_status: 200,
      latency_ms: 10,
      route_reason: "primary",
      fallback_from: "",
      is_final_success_attempt: 1,
      is_user_visible_operation: 1,
      analytics_dimensions: { test_run: instanceId },
      event_text_properties: {},
      event_number_properties: {},
      event_boolean_properties: {},
      event_datetime_properties: {},
      event_enum_properties: {},
      event_text_list_properties: {},
      user_text_properties: {},
      user_number_properties: {},
      user_boolean_properties: {},
      user_datetime_properties: {},
      user_enum_properties: {},
      user_text_list_properties: {},
      raw_payload: "{}",
      payload_hash: "a".repeat(64),
      sink_delivery_id: `${instanceId}-delivery-${index}`,
      source_outbox_id: String(index + 1),
      inserted_at: eventTime,
    }));

    await expect(
      operations.insertRows({
        name: "integration.raw.insert",
        table: "usage_events_raw",
        rows: rawRows,
      }),
    ).resolves.toMatchObject({ rows: 10_000 });

    const rawCount = await operations.queryRows<{ count: string }>({
      name: "integration.raw.count",
      query:
        "SELECT toString(count()) AS count FROM usage_events_raw WHERE instance_id = {instanceId:String}",
      queryParams: { instanceId },
    });
    expect(rawCount.rows).toEqual([{ count: "10000" }]);

    const aggregate = await operations.queryRows<{
      request_count: string;
      fallback_count: string;
    }>({
      name: "integration.aggregate.read",
      query: `SELECT
        toString(sum(request_count)) AS request_count,
        toString(sum(fallback_count)) AS fallback_count
      FROM usage_agg_1m
      WHERE instance_id = {instanceId:String}
      GROUP BY instance_id`,
      queryParams: { instanceId },
    });
    expect(aggregate.rows).toEqual([{ request_count: "10000", fallback_count: "0" }]);

    const dimensionCount = await operations.queryRows<{ count: string }>({
      name: "integration.dimension.read",
      query: `SELECT toString(count()) AS count
        FROM usage_events_raw
        WHERE instance_id = {instanceId:String}
          AND analytics_dimensions[{dimensionKey:String}] = {dimensionValue:String}`,
      queryParams: { instanceId, dimensionKey: "test_run", dimensionValue: instanceId },
    });
    expect(dimensionCount.rows).toEqual([{ count: "10000" }]);

    const ratingBase = {
      application_id: "integration-application",
      instance_id: instanceId,
      environment: "integration",
      event_date: eventDate,
      event_time: eventTime,
      source_event_id: `${instanceId}-event-0`,
      rating_kind: "provider_cost",
      request_id: `${instanceId}-request-0`,
      attempt_id: `${instanceId}-attempt-0`,
      operation_id: `${instanceId}-operation-0`,
      user_id: "integration-user",
      virtual_model: "integration-model",
      model_id: "integration-model-id",
      request_model: "integration/model",
      provider: "integration-provider",
      status: "official",
      attempt_outcome: "success",
      route_reason: "primary",
      usage_type: null,
      currency: "USD",
      aiu_micros: null,
      price_version_id: "integration-price-current",
      aiu_rate_version_id: null,
      calculation_version: "integration-current",
      reason: "integration correction",
      source_outbox_id: "10001",
      authority_outbox_id: "10001",
      inserted_at: eventTime,
    };
    await operations.insertRows({
      name: "integration.rating.insert",
      table: "rating_events",
      rows: [
        {
          ...ratingBase,
          rating_event_id: `${instanceId}-provisional`,
          rating_stage: "provisional",
          rating_sign: 1,
          amount_decimal: "10",
          rating_fingerprint: `sha256:${"b".repeat(64)}`,
          sink_delivery_id: `${instanceId}-rating-provisional`,
        },
        {
          ...ratingBase,
          rating_event_id: `${instanceId}-correction`,
          rating_stage: "correction",
          rating_sign: -1,
          amount_decimal: "3",
          rating_fingerprint: `sha256:${"c".repeat(64)}`,
          sink_delivery_id: `${instanceId}-rating-correction`,
          source_outbox_id: "10002",
          authority_outbox_id: "10002",
        },
      ],
    });
    const corrected = await operations.queryRows<{
      provisional: string;
      official_delta: string;
      realtime: string;
    }>({
      name: "integration.correction.read",
      query: `SELECT
        toDecimalString(sum(provisional_provider_cost), 18) AS provisional,
        toDecimalString(sum(official_provider_cost_delta), 18) AS official_delta,
        toDecimalString(sum(provisional_provider_cost + official_provider_cost_delta), 18) AS realtime
      FROM usage_agg_1m
      WHERE instance_id = {instanceId:String} AND currency = 'USD'
      GROUP BY instance_id, currency`,
      queryParams: { instanceId },
    });
    expect(corrected.rows).toEqual([
      {
        provisional: "10.000000000000000000",
        official_delta: "-3.000000000000000000",
        realtime: "7.000000000000000000",
      },
    ]);

    const ttl = await migrationClient.query({
      query: `SELECT create_table_query FROM system.tables
        WHERE database = {database:String} AND name = 'usage_events_raw'`,
      query_params: { database: migrationConfig.database },
      format: "JSONEachRow",
    });
    const ttlRows = await ttl.json<{ create_table_query: string }>();
    expect(ttlRows[0]?.create_table_query).toContain("toIntervalDay(90)");

    await expect(
      operations.queryRows({
        name: "integration.timeout.read",
        query: "SELECT sleep(3)",
        timeoutMs: 100,
      }),
    ).rejects.toBeDefined();
  }, 60_000);
});

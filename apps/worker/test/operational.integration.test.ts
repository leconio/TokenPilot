import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createClickHouseClient,
  loadClickHouseConfig,
  type ClickHouseClient,
} from "@tokenpilot/clickhouse";
import {
  ApiKeyStatus,
  ConnectorStatus,
  createPrismaClient,
  type DatabaseClient,
} from "@tokenpilot/db";

import { OperationalProcessor } from "../src/operational-processor.js";

const enabled =
  process.env.TEST_DATABASE_URL !== undefined && process.env.CLICKHOUSE_PASSWORD !== undefined;
const adminDatabaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://invalid/disabled";
const databaseName = `ai_control_ops_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(adminDatabaseUrl);
databaseUrl.pathname = `/${databaseName}`;
const instanceId = `worker-operational-${process.pid}-${Date.now()}`;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function clickHouseDate(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function rawUsageRow(input: {
  readonly applicationId: string;
  readonly eventId: string;
  readonly eventTime: Date;
  readonly requestId: string;
  readonly attemptId: string;
  readonly displayUser: string;
  readonly status: string;
}) {
  const eventTime = clickHouseDate(input.eventTime);
  return {
    application_id: input.applicationId,
    instance_id: instanceId,
    environment: "integration",
    application_version: "1.0.0",
    sdk_version: "1.0.0",
    connector_version: "1.0.0",
    config_version: "1",
    event_date: input.eventTime.toISOString().slice(0, 10),
    event_time: eventTime,
    received_at: eventTime,
    event_id: input.eventId,
    schema_version: "2.0",
    request_id: input.requestId,
    attempt_id: input.attemptId,
    operation_id: `${input.requestId}:operation`,
    session_id: "session-operational",
    conversation_id: "conversation-operational",
    trace_id: "trace-operational",
    user_id: "user-operational",
    display_user: input.displayUser,
    virtual_model: "text.fast",
    model_id: "model-operational",
    request_model: "openai/gpt-test",
    provider: "openai",
    status: input.status,
    error_class: "",
    http_status: input.status === "success" ? 200 : 500,
    latency_ms: 10,
    route_reason: "primary",
    fallback_from: "",
    is_final_success_attempt: input.status === "success" ? 1 : 0,
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
    payload_hash: "b".repeat(64),
    sink_delivery_id: `${input.eventId}:raw`,
    source_outbox_id: `${input.eventId}:outbox`,
    inserted_at: eventTime,
  };
}

describe.skipIf(!enabled)("operational jobs", () => {
  let admin: Client;
  let database: DatabaseClient;
  let clickhouse: ClickHouseClient;
  let temporary: string;
  let processor: OperationalProcessor;
  let exportApplicationId: string;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminDatabaseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    execFileSync("pnpm", ["--filter", "@tokenpilot/db", "db:migrate"], {
      cwd: new URL("../../../", import.meta.url),
      env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
      stdio: "pipe",
    });
    database = createPrismaClient(databaseUrl.toString());
    exportApplicationId = (
      await database.application.create({
        data: { name: "Export acceptance", slug: "export-acceptance", settings: { create: {} } },
      })
    ).id;
    clickhouse = createClickHouseClient(loadClickHouseConfig(process.env));
    temporary = await mkdtemp(join(tmpdir(), "tokenpilot-exports-"));
    processor = new OperationalProcessor(database, {
      clickhouse,
      exportDirectory: temporary,
      connectorStaleAfterSeconds: 60,
    });
  }, 30_000);

  afterAll(async () => {
    if (temporary !== undefined) await rm(temporary, { recursive: true, force: true });
    if (clickhouse !== undefined) await clickhouse.close();
    if (database !== undefined) await database.$disconnect();
    if (admin !== undefined) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
      await admin.end();
    }
  });

  it("exports exact ClickHouse Provider Cost and AIU values in a formula-safe CSV", async () => {
    const eventId = `${instanceId}-rated`;
    const eventTime = new Date("2026-07-15T08:00:00.000Z");
    const insertedAt = clickHouseDate(new Date("2026-07-15T08:00:01.000Z"));
    await clickhouse.insert({
      table: "usage_events_raw",
      values: [
        rawUsageRow({
          applicationId: exportApplicationId,
          eventId,
          eventTime,
          requestId: "=FORMULA-REQUEST",
          attemptId: "attempt-operational",
          displayUser: "+formula-user",
          status: "success",
        }),
      ],
      format: "JSONEachRow",
    });
    const ratingBase = {
      application_id: exportApplicationId,
      instance_id: instanceId,
      environment: "integration",
      event_date: eventTime.toISOString().slice(0, 10),
      event_time: clickHouseDate(eventTime),
      source_event_id: eventId,
      request_id: "=FORMULA-REQUEST",
      attempt_id: "attempt-operational",
      operation_id: "formula-operation",
      user_id: "user-operational",
      virtual_model: "text.fast",
      model_id: "model-operational",
      request_model: "openai/gpt-test",
      provider: "openai",
      status: "official",
      attempt_outcome: "success",
      route_reason: "primary",
      calculation_version: "operational-current",
      reason: "operational integration fixture",
      inserted_at: insertedAt,
    };
    await clickhouse.insert({
      table: "rating_events",
      values: [
        {
          ...ratingBase,
          rating_event_id: `${eventId}:provider-cost`,
          rating_kind: "provider_cost",
          rating_stage: "official",
          rating_sign: 1,
          usage_type: null,
          currency: "USD",
          amount_decimal: "1.000000000000000001",
          aiu_micros: null,
          price_version_id: "price-current",
          aiu_rate_version_id: null,
          rating_fingerprint: `sha256:${"c".repeat(64)}`,
          sink_delivery_id: `${eventId}:provider-cost:delivery`,
          source_outbox_id: `${eventId}:provider-cost:outbox`,
          authority_outbox_id: "10001",
        },
        {
          ...ratingBase,
          rating_event_id: `${eventId}:aiu`,
          rating_kind: "aiu",
          rating_stage: "official",
          rating_sign: 1,
          usage_type: "request",
          currency: null,
          amount_decimal: null,
          aiu_micros: "42",
          price_version_id: null,
          aiu_rate_version_id: "aiu-current",
          rating_fingerprint: `sha256:${"d".repeat(64)}`,
          sink_delivery_id: `${eventId}:aiu:delivery`,
          source_outbox_id: `${eventId}:aiu:outbox`,
          authority_outbox_id: "10002",
        },
      ],
      format: "JSONEachRow",
    });

    const exported = await processor.process({
      applicationId: exportApplicationId,
      kind: "exports.generate",
      idempotencyKey: "test-export",
      parameters: {
        from: "2026-07-15T08:00:00Z",
        to: "2026-07-15T09:00:00Z",
        format: "csv",
      },
    });
    expect(exported.result).toMatchObject({ row_count: 1, content_included: false });
    const output = await readFile(exported.result.path as string, "utf8");
    expect(output).toContain("'=FORMULA-REQUEST");
    expect(output).toContain("'+formula-user");
    expect(output).toContain("1.000000000000000001");
    expect(output).toContain('"42"');
    expect(output).not.toContain("content_free");
    expect(await database.backgroundJob.count()).toBe(1);
  });

  it("runs heartbeat, API-key and ClickHouse unpriced maintenance idempotently", async () => {
    await clickhouse.insert({
      table: "usage_events_raw",
      values: [
        rawUsageRow({
          applicationId: exportApplicationId,
          eventId: `${instanceId}-unpriced`,
          eventTime: new Date(),
          requestId: "request-unpriced",
          attemptId: "attempt-unpriced",
          displayUser: "Maintenance user",
          status: "failure",
        }),
      ],
      format: "JSONEachRow",
    });
    const application = await database.application.create({
      data: { name: "Operations", slug: "operations", settings: { create: {} } },
    });
    await database.connectorInstance.create({
      data: {
        applicationId: application.id,
        instanceId: "stale-connector",
        name: "litellm",
        type: "litellm",
        version: "1.0.0",
        status: ConnectorStatus.HEALTHY,
        lastHeartbeatAt: new Date(Date.now() - 120_000),
        metadataJson: {},
      },
    });
    await database.applicationApiKey.create({
      data: {
        applicationId: application.id,
        name: "expired key",
        keyPrefix: "tp_expired-key",
        keyHash: "f".repeat(64),
        scopes: ["usage:read"],
        createdAt: new Date(Date.now() - 172_800_000),
        expiresAt: new Date(Date.now() - 86_400_000),
      },
    });
    const jobs = [
      ["connector.heartbeat.check", "test-heartbeat"],
      ["unpriced.alert", "test-unpriced"],
      ["api_key.expiry", "test-key-expiry"],
    ] as const;
    for (const [kind, idempotencyKey] of jobs) {
      await processor.process({ kind, idempotencyKey, parameters: {} });
      await processor.process({ kind, idempotencyKey, parameters: {} });
    }

    expect(
      (
        await database.connectorInstance.findUniqueOrThrow({
          where: {
            applicationId_instanceId: {
              applicationId: application.id,
              instanceId: "stale-connector",
            },
          },
        })
      ).status,
    ).toBe(ConnectorStatus.STALE);
    expect(
      (
        await database.applicationApiKey.findUniqueOrThrow({
          where: { keyPrefix: "tp_expired-key" },
        })
      ).status,
    ).toBe(ApiKeyStatus.EXPIRED);
    expect(
      await database.auditLog.count({
        where: { action: "alert.unpriced", objectType: "current_usage_events_raw" },
      }),
    ).toBe(1);
    expect(await database.backgroundJob.count({ where: { status: "COMPLETED" } })).toBe(4);
  });
});

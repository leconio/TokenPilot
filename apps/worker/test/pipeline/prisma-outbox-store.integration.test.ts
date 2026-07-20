import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient, type DatabaseClient } from "@tokenpilot/db";

import { PrismaClickHouseOutboxStore } from "../../src/pipeline/prisma-outbox-store.js";

const enabled = process.env.TEST_DATABASE_URL !== undefined;
const adminDatabaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://invalid/disabled";
const databaseName = `tokenpilot_outbox_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
const databaseUrl = new URL(adminDatabaseUrl);
databaseUrl.pathname = `/${databaseName}`;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

describe.skipIf(!enabled)("Prisma ClickHouse Outbox cursor", () => {
  let admin: Client;
  let database: DatabaseClient;
  let sharedApplicationId: string;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminDatabaseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    execFileSync("pnpm", ["--filter", "@tokenpilot/db", "db:migrate"], {
      cwd: new URL("../../../../", import.meta.url),
      env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
      stdio: "pipe",
    });
    database = createPrismaClient(databaseUrl.toString());
    const application = await database.application.create({
      data: { name: "Outbox integration", slug: `outbox-integration-${randomUUID()}` },
    });
    sharedApplicationId = application.id;
  }, 60_000);

  afterAll(async () => {
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

  it("does not regress when a lower Outbox batch commits after a higher batch", async () => {
    const nonce = randomUUID();
    const eventType = `sync-watermark-${nonce}`;
    const pipelineName = `sync-watermark-${nonce}`;
    const lowStore = new PrismaClickHouseOutboxStore(database, {
      pipelineName,
      workerId: `low-${nonce}`,
    });
    const highStore = new PrismaClickHouseOutboxStore(database, {
      pipelineName,
      workerId: `high-${nonce}`,
    });
    try {
      await database.pipelineOutbox.create({
        data: {
          applicationId: sharedApplicationId,
          aggregateType: "acceptance",
          aggregateId: `low-${nonce}`,
          eventType,
          payloadJson: { acceptance: "low" },
          idempotencyKey: `sync-watermark-low-${nonce}`,
        },
      });
      const low = await lowStore.leaseOutbox([eventType], 1);
      expect(low).toHaveLength(1);

      await database.pipelineOutbox.create({
        data: {
          applicationId: sharedApplicationId,
          aggregateType: "acceptance",
          aggregateId: `high-${nonce}`,
          eventType,
          payloadJson: { acceptance: "high" },
          idempotencyKey: `sync-watermark-high-${nonce}`,
        },
      });
      const high = await highStore.leaseOutbox([eventType], 1);
      expect(high).toHaveLength(1);
      expect(high[0]!.id).toBeGreaterThan(low[0]!.id);

      await highStore.markDelivered(high, {
        outboxIds: [high[0]!.id],
        rowCount: 1,
        maxOutboxId: high[0]!.id,
        maxEventTime: new Date("2026-07-16T02:00:00.000Z"),
      });
      await lowStore.markDelivered(low, {
        outboxIds: [low[0]!.id],
        rowCount: 1,
        maxOutboxId: low[0]!.id,
        maxEventTime: new Date("2026-07-16T01:00:00.000Z"),
      });

      await expect(
        database.clickhouseSyncState.findUniqueOrThrow({ where: { pipelineName } }),
      ).resolves.toMatchObject({
        lastOutboxId: high[0]!.id,
        lastEventTime: new Date("2026-07-16T02:00:00.000Z"),
      });
    } finally {
      await database.pipelineOutbox.deleteMany({ where: { eventType } });
      await database.clickhouseSyncState.deleteMany({ where: { pipelineName } });
    }
  });

  it("marks every raw event before an earlier official-rating Outbox record", async () => {
    const eventId = `01${randomUUID().replaceAll("-", "").slice(0, 24)}`.toUpperCase();
    const application = await database.application.create({
      data: { name: `Outbox ${eventId}`, slug: `outbox-${eventId.toLowerCase()}` },
    });
    const applicationUser = await database.applicationUser.create({
      data: { applicationId: application.id, externalId: `user-${eventId}` },
    });
    await database.usageEventRegistry.create({
      data: {
        applicationId: application.id,
        applicationUserId: applicationUser.id,
        externalUserId: applicationUser.externalId,
        requestModel: "integration-model",
        eventId,
        schemaVersion: "2.0",
        payloadHash: "a".repeat(64),
        requestId: `request-${eventId}`,
        attemptId: `attempt-${eventId}`,
        instanceId: "outbox-order-integration",
        resultStatus: "success",
        eventTime: new Date("2026-07-17T01:00:00.000Z"),
        sourceType: "integration",
      },
    });
    await database.pipelineOutbox.create({
      data: {
        applicationId: application.id,
        aggregateType: "provider_cost_rating",
        aggregateId: eventId,
        eventType: "provider_cost.official_delta",
        payloadJson: { event_id: eventId },
        idempotencyKey: `official-before-raw-${eventId}`,
      },
    });
    await database.pipelineOutbox.create({
      data: {
        applicationId: application.id,
        aggregateType: "usage_event",
        aggregateId: eventId,
        eventType: "usage_events_raw",
        payloadJson: { event_id: eventId },
        idempotencyKey: `raw-after-official-${eventId}`,
      },
    });

    const store = new PrismaClickHouseOutboxStore(database, {
      pipelineName: `sync-order-${eventId}`,
      workerId: `sync-order-${eventId}`,
    });
    const leases = await store.leaseOutbox(["provider_cost.official_delta", "usage_events_raw"], 2);
    expect(leases.map((lease) => lease.eventType)).toEqual([
      "provider_cost.official_delta",
      "usage_events_raw",
    ]);

    await store.markDelivered(leases, {
      outboxIds: leases.map((lease) => lease.id),
      rowCount: 2,
      maxOutboxId: leases.at(-1)!.id,
      maxEventTime: new Date("2026-07-17T01:00:00.000Z"),
    });

    await expect(
      database.usageEventRegistry.findFirstOrThrow({ where: { eventId } }),
    ).resolves.toMatchObject({
      clickhouseRawSyncedAt: expect.any(Date),
      clickhouseOfficialSyncedAt: expect.any(Date),
    });
  });

  it("persists an Outbox-owned dead letter without requiring an ingestion identity", async () => {
    const nonce = randomUUID();
    const eventType = `outbox-dead-letter-${nonce}`;
    const outbox = await database.pipelineOutbox.create({
      data: {
        applicationId: sharedApplicationId,
        aggregateType: "acceptance",
        aggregateId: nonce,
        eventType,
        payloadJson: { acceptance: true },
        idempotencyKey: `outbox-dead-letter-${nonce}`,
      },
    });
    const store = new PrismaClickHouseOutboxStore(database, {
      pipelineName: `outbox-dead-letter-${nonce}`,
      workerId: `outbox-dead-letter-${nonce}`,
    });
    const [lease] = await store.leaseOutbox([eventType], 1);
    expect(lease).toBeDefined();

    await store.deadLetter(lease!, {
      code: "ACCEPTANCE_PAYLOAD_INVALID",
      errorClass: "TypeError",
      message: "safe acceptance failure",
      retryable: false,
    });

    await expect(
      database.pipelineOutbox.findUniqueOrThrow({ where: { id: outbox.id } }),
    ).resolves.toMatchObject({ status: "DEAD_LETTER" });
    await expect(
      database.deadLetterEvent.findFirstOrThrow({ where: { outboxId: outbox.id } }),
    ).resolves.toMatchObject({
      applicationId: sharedApplicationId,
      eventId: null,
      inboxId: null,
      outboxId: outbox.id,
      errorCode: "ACCEPTANCE_PAYLOAD_INVALID",
    });
  });
});

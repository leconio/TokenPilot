import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ApplicationRole,
  createPrismaClient,
  PipelineStage,
  type DatabaseClient,
} from "../src/index.js";

const enabled = process.env.TEST_DATABASE_URL !== undefined;
const adminDatabaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://invalid/disabled";
const databaseName = `tokenpilot_schema_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
const databaseUrl = new URL(adminDatabaseUrl);
databaseUrl.pathname = `/${databaseName}`;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

describe.skipIf(!enabled)("current empty-database schema", () => {
  let admin: Client;
  let database: DatabaseClient;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminDatabaseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    for (let index = 0; index < 2; index += 1) {
      execFileSync("pnpm", ["--filter", "@tokenpilot/db", "db:migrate"], {
        cwd: new URL("../../../", import.meta.url),
        env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
        stdio: "pipe",
      });
    }
    database = createPrismaClient(databaseUrl.toString());
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

  it("keeps users, models, queues, and failures inside one application", async () => {
    const [first, second] = await Promise.all([
      database.application.create({ data: { name: "First", slug: `first-${randomUUID()}` } }),
      database.application.create({ data: { name: "Second", slug: `second-${randomUUID()}` } }),
    ]);

    const [firstUser, secondUser] = await Promise.all([
      database.applicationUser.create({
        data: { applicationId: first.id, externalId: "shared-user", name: "First user" },
      }),
      database.applicationUser.create({
        data: { applicationId: second.id, externalId: "shared-user", name: "Second user" },
      }),
    ]);
    expect(firstUser.id).not.toBe(secondUser.id);
    await expect(
      database.applicationUser.count({
        where: { applicationId: first.id, externalId: "shared-user" },
      }),
    ).resolves.toBe(1);

    const [firstModel, secondModel] = await Promise.all([
      database.modelDefinition.create({
        data: { applicationId: first.id, name: "First model", litellmTag: "shared-tag" },
      }),
      database.modelDefinition.create({
        data: { applicationId: second.id, name: "Second model", litellmTag: "shared-tag" },
      }),
    ]);
    await expect(
      database.virtualModel.create({
        data: {
          applicationId: first.id,
          name: "cross-app",
          displayName: "Cross application",
          defaultModelId: secondModel.id,
        },
      }),
    ).rejects.toThrow();
    expect(firstModel.id).not.toBe(secondModel.id);

    const [firstOutbox, secondOutbox] = await Promise.all([
      database.pipelineOutbox.create({
        data: {
          applicationId: first.id,
          aggregateType: "test",
          aggregateId: "same-event",
          eventType: "usage_events_raw",
          payloadJson: { application_id: first.id },
          idempotencyKey: "same-key",
        },
      }),
      database.pipelineOutbox.create({
        data: {
          applicationId: second.id,
          aggregateType: "test",
          aggregateId: "same-event",
          eventType: "usage_events_raw",
          payloadJson: { application_id: second.id },
          idempotencyKey: "same-key",
        },
      }),
    ]);
    expect(firstOutbox.id).not.toBe(secondOutbox.id);
    await expect(
      database.pipelineOutbox.create({
        data: {
          applicationId: first.id,
          aggregateType: "test",
          aggregateId: "duplicate",
          eventType: "usage_events_raw",
          payloadJson: {},
          idempotencyKey: "same-key",
        },
      }),
    ).rejects.toThrow();
    await expect(
      database.deadLetterEvent.create({
        data: {
          applicationId: first.id,
          outboxId: secondOutbox.id,
          stage: PipelineStage.OUTBOX_CREATED,
          errorCode: "CROSS_APPLICATION_TEST",
          errorClass: "TestError",
          errorMessage: "This relation must be rejected",
        },
      }),
    ).rejects.toThrow();
  });

  it("enforces current application archive and member permission invariants", async () => {
    const application = await database.application.create({
      data: { name: "Permissions", slug: `permissions-${randomUUID()}` },
    });
    const user = await database.user.create({
      data: {
        id: randomUUID(),
        name: "Read only",
        email: `reader-${randomUUID()}@example.test`,
      },
    });
    await expect(
      database.applicationMember.create({
        data: {
          applicationId: application.id,
          userId: user.id,
          role: ApplicationRole.VIEWER,
          permissions: ["admin:write"],
        },
      }),
    ).rejects.toThrow();
    await expect(
      database.application.update({
        where: { id: application.id },
        data: { archivedAt: new Date() },
      }),
    ).rejects.toThrow();
  });
});

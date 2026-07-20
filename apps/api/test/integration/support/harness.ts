import { execFileSync } from "node:child_process";

import { Client } from "pg";

import type { UsageEvent } from "@tokenpilot/contracts";
import { syncApplicationApiKey, type DatabaseClient } from "@tokenpilot/db";

import { createApiApplication } from "../../../src/application.js";
import { createApiInfrastructure, type ApiInfrastructure } from "../../../src/infrastructure.js";
import { WebAuthService } from "../../../src/web-auth.service.js";
import {
  adminKey,
  adminDatabaseUrl,
  applicationName,
  applicationSlug,
  configuration,
  databaseName,
  ingestKey,
  migrationEnvironment,
  policyKey,
} from "./config.js";
import { usageEvent } from "./fixtures.js";

let admin: Client;
export let infrastructure: ApiInfrastructure;
export let database: DatabaseClient;
export let application: Awaited<ReturnType<typeof createApiApplication>>;
export let server: ReturnType<typeof application.getHttpAdapter>["getInstance"] extends (
  ...arguments_: never[]
) => infer Instance
  ? Instance
  : never;
export let originalEvents: UsageEvent[];
export let controlPlaneUrl: string;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function startIntegrationHarness(): Promise<void> {
  admin = new Client({ connectionString: adminDatabaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  execFileSync("pnpm", ["--filter", "@tokenpilot/db", "db:migrate"], {
    cwd: new URL("../../../../../", import.meta.url),
    env: migrationEnvironment(),
    stdio: "pipe",
  });
  infrastructure = createApiInfrastructure(configuration);
  database = infrastructure.database;
  await infrastructure.redis.flushdb();
  application = await createApiApplication(configuration, { infrastructure });
  await application.listen(0, "127.0.0.1");
  controlPlaneUrl = await application.getUrl();
  server = application.getHttpAdapter().getInstance();
  await application.get(WebAuthService).initialize({
    name: "Integration administrator",
    email: "admin@example.test",
    password: "correct horse battery staple",
    application_name: applicationName,
  });
  const managedApplication = await database.application.findUniqueOrThrow({
    where: { slug: applicationSlug },
  });
  await Promise.all([
    syncApplicationApiKey(database, {
      applicationId: managedApplication.id,
      name: "integration ingest",
      rawKey: ingestKey,
      scopes: ["usage:write", "connector:heartbeat"],
      pepper: configuration.apiKeyPepper,
    }),
    syncApplicationApiKey(database, {
      applicationId: managedApplication.id,
      name: "integration runtime",
      rawKey: policyKey,
      scopes: ["runtime:read", "runtime:write", "runtime:ack"],
      pepper: configuration.apiKeyPepper,
    }),
    syncApplicationApiKey(database, {
      applicationId: managedApplication.id,
      name: "integration administration",
      rawKey: adminKey,
      scopes: [
        "usage:read",
        "model:read",
        "model:write",
        "configuration:read",
        "configuration:write",
        "admin:read",
        "admin:write",
        "pricing:read",
        "pricing:write",
        "reports:read",
        "jobs:read",
        "jobs:write",
        "reconciliation:read",
        "reconciliation:write",
      ],
      pepper: configuration.apiKeyPepper,
    }),
  ]);
  originalEvents = Array.from({ length: 100 }, () => usageEvent());
}

export async function stopIntegrationHarness(): Promise<void> {
  if (infrastructure !== undefined) await infrastructure.redis.flushdb();
  if (application !== undefined) await application.close();
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [databaseName],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
  await admin.end();
}

export async function postJson(url: string, body: unknown) {
  return server.inject({
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${ingestKey}`,
      "content-type": "application/json",
    },
    payload: JSON.stringify(body),
  });
}

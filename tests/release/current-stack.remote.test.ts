import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import {
  batchIngestionResponseSchema,
  connectorHeartbeatSchema,
  usageBatchSchema,
  type ConnectorHeartbeat,
  type UsageBatch,
} from "../../packages/contracts/src/index.js";

const enabled = process.env.REMOTE_RELEASE_ACCEPTANCE === "true";
const apiUrl = process.env.RELEASE_API_URL?.replace(/\/$/u, "") ?? "http://127.0.0.1:1";
const ingestKey = process.env.RELEASE_INGEST_API_KEY ?? "missing";
const adminKey = process.env.RELEASE_ADMIN_API_KEY ?? "missing";
const applicationSlug = process.env.REAL_STACK_APPLICATION_SLUG ?? "acceptance";
const applicationPath = `/applications/${encodeURIComponent(applicationSlug)}`;

interface JsonResponse {
  readonly response: Response;
  readonly body: unknown;
}

async function jsonRequest(
  path: string,
  options: RequestInit = {},
  apiKey?: string,
): Promise<JsonResponse> {
  const headers = new Headers(options.headers);
  headers.set("accept", "application/json");
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (apiKey !== undefined) headers.set("authorization", `Bearer ${apiKey}`);
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) body = JSON.parse(text);
  return { response, body };
}

async function currentBatch(): Promise<UsageBatch> {
  const source = JSON.parse(
    await readFile(
      new URL("../../fixtures/contracts/current/valid/usage-batch.json", import.meta.url),
      "utf8",
    ),
  ) as UsageBatch;
  const batchId = ulid();
  const eventId = ulid();
  const now = new Date().toISOString();
  const event = source.events[0]!;
  return usageBatchSchema.parse({
    ...source,
    batch_id: batchId,
    sent_at: now,
    events: [
      {
        ...event,
        event_id: eventId,
        event_time: now,
        source: { ...event.source, instance_id: `release-${batchId.toLowerCase()}` },
        request: {
          ...event.request,
          request_id: `release-request-${eventId.toLowerCase()}`,
          attempt_id: `release-attempt-${eventId.toLowerCase()}`,
        },
      },
    ],
  });
}

async function currentHeartbeat(instanceId: string): Promise<ConnectorHeartbeat> {
  const source = JSON.parse(
    await readFile(
      new URL("../../fixtures/contracts/current/valid/connector-heartbeat.json", import.meta.url),
      "utf8",
    ),
  ) as ConnectorHeartbeat;
  const now = new Date().toISOString();
  return connectorHeartbeatSchema.parse({
    ...source,
    heartbeat_id: ulid(),
    sent_at: now,
    connector: { ...source.connector, instance_id: instanceId, version: "0.2.0" },
    oldest_event_age_seconds: null,
    last_successful_upload_at: now,
  });
}

describe.skipIf(!enabled).sequential("remote current-stack acceptance", () => {
  let batch: UsageBatch;
  const connectorInstanceId = `release-connector-${ulid().toLowerCase()}`;

  beforeAll(async () => {
    batch = await currentBatch();
  });

  it("exposes ready health and only unversioned control-plane routes", async () => {
    const health = await fetch(`${apiUrl}/health/ready`, {
      signal: AbortSignal.timeout(30_000),
    });
    expect(health.status).toBe(200);

    const openApi = await jsonRequest("/openapi-json");
    expect(openApi.response.status).toBe(200);
    const document = openApi.body as { paths?: Record<string, unknown> };
    const paths = Object.keys(document.paths ?? {});
    expect(paths.length).toBeGreaterThan(20);
    expect(paths.some((path) => /^\/v\d+(?:\/|$)/u.test(path))).toBe(false);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/usage-events/batch",
        "/connectors/heartbeat",
        "/applications/{applicationSlug}/users",
        "/applications/{applicationSlug}/models",
        "/applications/{applicationSlug}/virtual-models",
      ]),
    );
  });

  it("accepts, deduplicates, and protects immutable usage event IDs", async () => {
    const send = (payload: UsageBatch) =>
      jsonRequest(
        "/usage-events/batch",
        { method: "POST", body: JSON.stringify(payload) },
        ingestKey,
      );

    const accepted = await send(batch);
    expect(accepted.response.status).toBe(202);
    expect(batchIngestionResponseSchema.parse(accepted.body)).toMatchObject({
      accepted: 1,
      duplicates: 0,
      conflicts: 0,
      rejected: 0,
    });

    const duplicate = await send(batch);
    expect(duplicate.response.status).toBe(202);
    expect(batchIngestionResponseSchema.parse(duplicate.body)).toMatchObject({
      accepted: 0,
      duplicates: 1,
      conflicts: 0,
    });

    const changed = structuredClone(batch);
    changed.events[0]!.usage = { request_count: "2" };
    const conflict = await send(changed);
    expect(conflict.response.status).toBe(202);
    expect(batchIngestionResponseSchema.parse(conflict.body)).toMatchObject({
      accepted: 0,
      duplicates: 0,
      conflicts: 1,
    });

    const reportedUser = await jsonRequest(
      `${applicationPath}/users?search=${encodeURIComponent("batch-user")}`,
      {},
      adminKey,
    );
    expect(reportedUser.response.status).toBe(200);
    expect(reportedUser.body).toMatchObject({
      users: [expect.objectContaining({ user_id: "batch-user", display_user: "Batch user" })],
    });
  });

  it("records a capability-bound heartbeat exactly once", async () => {
    const heartbeat = await currentHeartbeat(connectorInstanceId);
    const send = () =>
      jsonRequest(
        "/connectors/heartbeat",
        {
          method: "POST",
          headers: {
            "x-request-id": heartbeat.heartbeat_id,
            "x-tokenpilot-usage-schemas": "2.0",
            "x-tokenpilot-privacy-mode": "content-free",
          },
          body: JSON.stringify(heartbeat),
        },
        ingestKey,
      );
    const accepted = await send();
    expect(accepted.response.status).toBe(202);
    expect(accepted.body).toMatchObject({
      status: "accepted",
      heartbeat_id: heartbeat.heartbeat_id,
      snapshot_updated: true,
    });
    const duplicate = await send();
    expect(duplicate.response.status).toBe(202);
    expect(duplicate.body).toMatchObject({
      status: "duplicate",
      heartbeat_id: heartbeat.heartbeat_id,
      snapshot_updated: false,
    });
  });

  it("surfaces the accepted connector through the administration API", async () => {
    const connectors = await jsonRequest(`${applicationPath}/connectors`, {}, adminKey);
    expect(connectors.response.status).toBe(200);
    expect(JSON.stringify(connectors.body)).toContain(connectorInstanceId);
  });
});

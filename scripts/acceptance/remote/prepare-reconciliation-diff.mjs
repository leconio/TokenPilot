#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { ulid } from "ulid";

if (process.env.REMOTE_RECONCILIATION_SETUP !== "true") {
  throw new Error("REMOTE_RECONCILIATION_SETUP=true is required");
}
const apiUrl = process.env.RELEASE_API_URL?.replace(/\/$/u, "");
const ingestKey = process.env.RELEASE_INGEST_API_KEY;
const adminKey = process.env.RELEASE_ADMIN_API_KEY;
const applicationSlug = process.env.RELEASE_APPLICATION_SLUG;
if (
  apiUrl === undefined ||
  ingestKey === undefined ||
  adminKey === undefined ||
  applicationSlug === undefined
) {
  throw new Error("Isolated API URL and machine credentials are required");
}
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(applicationSlug)) {
  throw new Error("The reconciliation application slug is invalid");
}
const reconciliationPath = `/applications/${encodeURIComponent(applicationSlug)}/reconciliation`;
const applicationPath = `/applications/${encodeURIComponent(applicationSlug)}`;
const parsedUrl = new URL(apiUrl);
if (parsedUrl.hostname !== "127.0.0.1" && parsedUrl.hostname !== "localhost") {
  throw new Error("Reconciliation setup requires a loopback-only isolated ingress");
}

async function request(path, options = {}, apiKey) {
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
  const body = text === "" ? null : JSON.parse(text);
  return { response, body };
}

async function poll(callback, description, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await callback();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

const fixture = JSON.parse(
  await readFile(
    new URL("../../../fixtures/contracts/current/valid/usage-batch.json", import.meta.url),
  ),
);
const eventId = ulid();
const batchId = ulid();
const requestId = `reconciliation-${eventId.toLowerCase()}`;
const attemptId = `reconciliation-attempt-${eventId.toLowerCase()}`;
const eventTime = new Date();
const event = fixture.events[0];
const payload = {
  ...fixture,
  batch_id: batchId,
  sent_at: eventTime.toISOString(),
  events: [
    {
      ...event,
      event_id: eventId,
      event_time: eventTime.toISOString(),
      source: { ...event.source, instance_id: `reconciliation-${batchId.toLowerCase()}` },
      request: { ...event.request, request_id: requestId, attempt_id: attemptId },
    },
  ],
};
const ingested = await request(
  "/usage-events/batch",
  { method: "POST", body: JSON.stringify(payload) },
  ingestKey,
);
if (ingested.response.status !== 202) throw new Error("The reconciliation event was not accepted");

await poll(async () => {
  const details = await request(
    `${applicationPath}/requests/${encodeURIComponent(requestId)}`,
    {},
    adminKey,
  );
  if (details.response.status === 404) return undefined;
  if (!details.response.ok) throw new Error("Request-detail polling failed");
  const attempts = details.body?.attempts;
  return Array.isArray(attempts) &&
    attempts.some((attempt) => attempt.raw_event?.processing_status === "completed")
    ? true
    : undefined;
}, "PostgreSQL official processing");

const rangeFrom = new Date(eventTime.getTime() - 60_000).toISOString();
const rangeTo = new Date(eventTime.getTime() + 60_000).toISOString();
const created = await request(
  `${reconciliationPath}/runs`,
  {
    method: "POST",
    body: JSON.stringify({
      type: "manual",
      from: rangeFrom,
      to: rangeTo,
      reason: "Isolated acceptance missing-projection fault injection",
    }),
  },
  adminKey,
);
if (!created.response.ok || typeof created.body?.id !== "string") {
  throw new Error("The manual reconciliation run was not created");
}
const runId = created.body.id;
const applicationId = created.body.application_id;
if (typeof applicationId !== "string") {
  throw new Error("The reconciliation run did not preserve its application identity");
}
await poll(async () => {
  const run = await request(`${reconciliationPath}/runs/${runId}`, {}, adminKey);
  if (!run.response.ok) throw new Error("Reconciliation run polling failed");
  if (run.body?.status === "failed") {
    throw new Error(`The reconciliation run failed: ${String(run.body?.error ?? "unknown error")}`);
  }
  return run.body?.status === "completed" ? run.body : undefined;
}, "a completed reconciliation run");
const result = await request(
  `${reconciliationPath}/runs/${runId}/diffs?page_size=200`,
  {},
  adminKey,
);
if (!result.response.ok || !Array.isArray(result.body?.diffs)) {
  throw new Error("Reconciliation diffs could not be read");
}
const diff = result.body.diffs.find(
  (candidate) =>
    typeof candidate.id === "string" &&
    candidate.status === "open" &&
    JSON.stringify(candidate.sample_event_ids ?? []).includes(eventId),
);
if (diff === undefined) throw new Error("The controlled missing projection did not create a diff");
process.stdout.write(
  `${JSON.stringify({
    status: "created",
    method: "redis_sink_pause_then_official_ingest_then_manual_reconciliation",
    event_id: eventId,
    application_id: applicationId,
    application_slug: applicationSlug,
    request_id: requestId,
    run_id: runId,
    diff_id: diff.id,
    range_from: rangeFrom,
    range_to: rangeTo,
  })}\n`,
);

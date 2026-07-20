#!/usr/bin/env node

import { ulid } from "ulid";

if (process.env.REMOTE_DEPENDENCY_OUTAGE_PROBE !== "true") {
  throw new Error("REMOTE_DEPENDENCY_OUTAGE_PROBE=true is required");
}
const dependency = process.env.ACCEPTANCE_OUTAGE_DEPENDENCY;
if (!new Set(["postgres", "redis", "clickhouse"]).has(dependency)) {
  throw new Error("ACCEPTANCE_OUTAGE_DEPENDENCY is invalid");
}
const apiUrl = process.env.RELEASE_API_URL?.replace(/\/$/u, "");
const liteLlmUrl = process.env.LITELLM_DEMO_URL?.replace(/\/$/u, "");
const adminKey = process.env.RELEASE_ADMIN_API_KEY;
const applicationSlug = process.env.REAL_STACK_APPLICATION_SLUG;
if (
  apiUrl === undefined ||
  liteLlmUrl === undefined ||
  (adminKey?.length ?? 0) < 32 ||
  applicationSlug === undefined
) {
  throw new Error("Isolated Control Plane, model gateway, and administrator inputs are required");
}
const api = new URL(apiUrl);
const gateway = new URL(liteLlmUrl);
if (
  !new Set(["127.0.0.1", "localhost"]).has(api.hostname) ||
  !new Set(["127.0.0.1", "localhost"]).has(gateway.hostname)
) {
  throw new Error("The outage probe requires loopback ingress");
}

const health = await fetch(`${apiUrl}/health/ready`, { signal: AbortSignal.timeout(30_000) });
if (health.status !== 503) {
  await health.body?.cancel();
  throw new Error(`Control Plane readiness must fail closed (received ${health.status})`);
}
await health.body?.cancel();

const to = new Date();
const from = new Date(to.getTime() - 3_600_000);
const reportUrl = new URL(
  `${apiUrl}/applications/${encodeURIComponent(applicationSlug)}/reports/overview`,
);
reportUrl.searchParams.set("from", from.toISOString());
reportUrl.searchParams.set("to", to.toISOString());
reportUrl.searchParams.set("timezone", "UTC");
let reportStatus = "request_failed";
try {
  const report = await fetch(reportUrl, {
    headers: { authorization: `Bearer ${adminKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (report.status < 500 || report.status > 599) {
    await report.body?.cancel();
    throw new Error(`Reports must return no data during an outage (received ${report.status})`);
  }
  reportStatus = String(report.status);
  await report.body?.cancel();
} catch (error) {
  if (error instanceof Error && error.message.startsWith("Reports must return")) throw error;
}

const requestId = `outage-${ulid().toLowerCase()}`;
const response = await fetch(`${liteLlmUrl}/v1/chat/completions`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model: "acceptance.chat",
    messages: [{ role: "user", content: "Run the isolated dependency outage check." }],
    metadata: {
      cp: {
        context_version: "1",
        request_id: requestId,
        operation_id: requestId,
        trace_id: `trace-${requestId}`,
        user_id: "dependency-outage-user",
        display_user: "Dependency outage user",
        analytics_dimensions: { acceptance_feature: "dependency-outage" },
      },
    },
  }),
  signal: AbortSignal.timeout(120_000),
});
if (response.status !== 200) {
  await response.body?.cancel();
  throw new Error(`Model gateway failed independently (received ${response.status})`);
}
await response.body?.cancel();
process.stdout.write(
  `${JSON.stringify({
    status: "passed",
    unavailable_dependency: dependency,
    control_plane_ready: false,
    control_plane_status: 503,
    report_status: reportStatus,
    model_gateway: "available",
    request_id: requestId,
  })}\n`,
);

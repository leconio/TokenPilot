#!/usr/bin/env node

import { chmod, writeFile } from "node:fs/promises";

const mode = process.env.REMOTE_WEB_ACCEPTANCE_SETUP;
if (!new Set(["prepare", "identify"]).has(mode)) {
  throw new Error("REMOTE_WEB_ACCEPTANCE_SETUP must be prepare or identify");
}
const apiUrl = process.env.RELEASE_API_URL?.replace(/\/$/u, "");
const email = process.env.REAL_STACK_ADMIN_EMAIL;
const password = process.env.REAL_STACK_ADMIN_PASSWORD;
const applicationName = process.env.REAL_STACK_APPLICATION_NAME ?? "Acceptance";
const expectedSlug = process.env.REAL_STACK_APPLICATION_SLUG ?? "acceptance";
const liteLlmEnvironment = process.env.LITELLM_ENV_FILE;
const acceptanceKeysEnvironment = process.env.REMOTE_ACCEPTANCE_KEYS_FILE;
if ([apiUrl, email, password].some((value) => value === undefined || value === "")) {
  throw new Error("Loopback API and ephemeral Web acceptance credentials are required");
}
const parsedUrl = new URL(apiUrl);
if (!new Set(["127.0.0.1", "localhost"]).has(parsedUrl.hostname)) {
  throw new Error("Web acceptance preparation requires loopback ingress");
}

async function request(path, options = {}, session) {
  const headers = new Headers(options.headers);
  headers.set("accept", "application/json");
  headers.set("origin", apiUrl);
  headers.set("sec-fetch-site", "same-origin");
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (session !== undefined) {
    headers.set("cookie", session.cookie);
    headers.set("x-csrf-token", session.csrf);
  }
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    const contentType = response.headers.get("content-type") ?? "missing";
    throw new Error(
      `${options.method ?? "GET"} ${path} returned a non-JSON response ` +
        `(HTTP ${response.status}, content-type ${contentType})`,
    );
  }
  return { response, body };
}

function requireOk(result, label) {
  if (!result.response.ok) {
    throw new Error(`${label} failed with HTTP ${result.response.status}`);
  }
  return result.body;
}

function sessionFrom(result) {
  const csrf = result.body?.csrf_token;
  const getSetCookie = result.response.headers.getSetCookie;
  const cookie =
    typeof getSetCookie === "function"
      ? getSetCookie
          .call(result.response.headers)
          .map((value) => value.split(";", 1)[0])
          .join("; ")
      : result.response.headers
          .get("set-cookie")
          ?.split(/,(?=[^;,]+=)/u)
          .map((value) => value.split(";", 1)[0])
          .join("; ");
  if (typeof csrf !== "string" || csrf.length < 16 || !cookie?.includes("cp_session=")) {
    throw new Error("Web session credentials were not issued");
  }
  return { csrf, cookie };
}

async function login() {
  const result = await request("/web/session/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  requireOk(result, "Web administrator login");
  return { body: result.body, session: sessionFrom(result) };
}

async function mutate(path, body, session, method = "POST") {
  return requireOk(
    await request(
      path,
      { method, body: body === undefined ? undefined : JSON.stringify(body) },
      session,
    ),
    `${method} ${path}`,
  );
}

const status = await request("/web/setup/status");
const setup = requireOk(status, "Setup status");
if (typeof setup?.setup_required !== "boolean") throw new Error("Setup status is invalid");

if (mode === "identify") {
  if (setup.setup_required) throw new Error("Web setup did not complete");
  const identified = await login();
  const adminUserId = identified.body?.user?.userId;
  if (typeof adminUserId !== "string") throw new Error("Web administrator identity is invalid");
  process.stdout.write(`${JSON.stringify({ status: "identified", admin_user_id: adminUserId })}\n`);
  process.exit(0);
}

if (!setup.setup_required) throw new Error("The disposable stack was not in a fresh setup state");
if (liteLlmEnvironment === undefined || liteLlmEnvironment === "") {
  throw new Error("LITELLM_ENV_FILE is required for isolated LiteLLM acceptance");
}
if (acceptanceKeysEnvironment === undefined || acceptanceKeysEnvironment === "") {
  throw new Error("REMOTE_ACCEPTANCE_KEYS_FILE is required for isolated acceptance");
}
const initialized = await request("/web/setup/initialize", {
  method: "POST",
  body: JSON.stringify({
    name: "Acceptance administrator",
    email,
    password,
    application_name: applicationName,
  }),
});
const initializedBody = requireOk(initialized, "Web setup");
const session = sessionFrom(initialized);
const applicationSlug = initializedBody?.application?.slug;
if (applicationSlug !== expectedSlug)
  throw new Error("The acceptance application slug is unexpected");
const appPath = `/api/control/applications/${encodeURIComponent(applicationSlug)}`;

await mutate(
  `${appPath}/properties`,
  {
    key: "next_action",
    display_name: "Next action",
    scope: "EVENT",
    data_type: "TEXT",
    searchable: true,
  },
  session,
);
await mutate(
  `${appPath}/properties`,
  {
    key: "member_level",
    display_name: "Member level",
    scope: "USER",
    data_type: "ENUM",
    allowed_values: ["acceptance", "other"],
    searchable: true,
    groupable: true,
  },
  session,
);

const usageKey = await mutate(
  `${appPath}/service-api-keys`,
  {
    name: "Acceptance usage",
    scopes: ["usage:write", "connector:heartbeat"],
    reason: "Isolated real-stack usage acceptance",
  },
  session,
);
const runtimeKey = await mutate(
  `${appPath}/service-api-keys`,
  {
    name: "Acceptance runtime",
    scopes: ["runtime:read", "runtime:write", "runtime:ack"],
    reason: "Isolated real-stack runtime acceptance",
  },
  session,
);
const adminKey = await mutate(
  `${appPath}/service-api-keys`,
  {
    name: "Acceptance administration",
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
    reason: "Isolated real-stack administration acceptance",
  },
  session,
);
if (
  typeof usageKey?.api_key !== "string" ||
  typeof runtimeKey?.api_key !== "string" ||
  typeof adminKey?.api_key !== "string"
) {
  throw new Error("Application-scoped acceptance keys were not issued");
}

const primary = await mutate(
  `${appPath}/models`,
  { name: "Acceptance primary", litellm_tag: "text.fast.demo-primary" },
  session,
);
const fallback = await mutate(
  `${appPath}/models`,
  { name: "Acceptance fallback", litellm_tag: "text.fast.demo-fallback" },
  session,
);
for (const model of [primary, fallback]) {
  if (typeof model?.id !== "string") throw new Error("Acceptance model creation failed");
  await mutate(
    `${appPath}/models/${model.id}/cost`,
    {
      request: "0.1",
      input_per_million: "1000",
      cache_read_per_million: "500",
      output_per_million: "2000",
      reasoning_per_million: "4000",
    },
    session,
    "PUT",
  );
  await mutate(
    `${appPath}/models/${model.id}/aiu`,
    {
      input_per_million: "1",
      cache_read_per_million: "0.5",
      cache_write_per_million: "1",
      output_per_million: "2",
      reasoning_per_million: "4",
    },
    session,
    "PUT",
  );
}
const virtualModel = await mutate(
  `${appPath}/virtual-models`,
  {
    name: "acceptance.chat",
    display_name: "Acceptance chat",
    default_model_id: primary.id,
  },
  session,
);
if (typeof virtualModel?.id !== "string") throw new Error("Acceptance virtual model failed");
await mutate(
  `${appPath}/virtual-models/${virtualModel.id}/routes`,
  { model_id: primary.id },
  session,
);
await mutate(
  `${appPath}/virtual-models/${virtualModel.id}/routes`,
  { model_id: fallback.id },
  session,
);
await mutate(`${appPath}/virtual-models/${virtualModel.id}`, { enabled: true }, session, "PATCH");
await mutate(`${appPath}/runtime-configurations/publish`, undefined, session);

const lines = [
  "AI_CONTROL_URL=http://api:4000",
  `AI_CONTROL_API_KEY=${usageKey.api_key}`,
  `AI_CONTROL_POLICY_API_KEY=${runtimeKey.api_key}`,
  "AI_CONTROL_CONNECTOR_INSTANCE_ID=litellm-acceptance",
  "AI_CONTROL_SPOOL_PATH=/var/lib/tokenpilot/litellm-demo-spool.sqlite3",
  "AI_CONTROL_POLICY_LKG_PATH=/var/lib/tokenpilot/runtime-snapshot.json",
  "AI_CONTROL_MAX_SPOOL_BYTES=536870912",
  "AI_CONTROL_BATCH_SIZE=100",
  "AI_CONTROL_FLUSH_INTERVAL_SECONDS=1",
  "AI_CONTROL_RETRY_BASE_SECONDS=1",
  "AI_CONTROL_RETRY_MAX_SECONDS=30",
  "AI_CONTROL_HEARTBEAT_INTERVAL_SECONDS=5",
  "AI_CONTROL_POLICY_POLL_INTERVAL_SECONDS=2",
];
await writeFile(liteLlmEnvironment, `${lines.join("\n")}\n`, { mode: 0o600 });
await chmod(liteLlmEnvironment, 0o600);
await writeFile(
  acceptanceKeysEnvironment,
  [
    `RELEASE_INGEST_API_KEY=${usageKey.api_key}`,
    `RELEASE_RUNTIME_API_KEY=${runtimeKey.api_key}`,
    `RELEASE_ADMIN_API_KEY=${adminKey.api_key}`,
    `RELEASE_APPLICATION_SLUG=${applicationSlug}`,
  ].join("\n") + "\n",
  { mode: 0o600 },
);
await chmod(acceptanceKeysEnvironment, 0o600);
process.stdout.write(
  `${JSON.stringify({
    status: "prepared",
    application_slug: applicationSlug,
    models: 2,
    virtual_models: 1,
    runtime_configuration: "published",
    typed_properties: 2,
    application_keys: 3,
  })}\n`,
);

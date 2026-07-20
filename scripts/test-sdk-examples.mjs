#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

function signedSnapshot(baseUrl) {
  const unsigned = {
    schema_version: "2.0",
    application_id: "00000000-0000-4000-8000-000000000042",
    version: "runtime-current-example",
    expires_at: "2099-07-16T18:00:00.000Z",
    connections: {
      "connection-example": {
        id: "connection-example",
        name: "Example OpenAI-compatible service",
        driver: "openai_compatible",
        base_url: `${baseUrl}/v1`,
        credential_ref: "EXAMPLE_PROVIDER_API_KEY",
        timeout_ms: 10_000,
        max_retries: 0,
      },
    },
    routing: {
      "customer-support": {
        virtual_model_id: "virtual-model-example",
        configuration_version: 1,
        configuration_etag: `sha256:${"b".repeat(64)}`,
        published_at: "2026-07-16T18:00:00.000Z",
        timezone: "UTC",
        default: {
          route_tag: "cp:customer-support:default",
          selection_mode: "ordered",
          targets: [
            {
              model_id: "00000000-0000-4000-8000-000000000001",
              connection_id: "connection-example",
              request_model: "example-chat-model",
              provider: "openai",
              task_type: "chat",
              capabilities: ["streaming"],
              route_tag: "cp:customer-support:default",
              fallback_order: 0,
              weight: 1,
            },
          ],
        },
        rules: [],
      },
    },
    aiu: { enabled: true, mode: "observe", unrated_model_policy: "alert_only" },
    access: { application_enabled: true, blocked_user_ids: [] },
    dimensions: { analytics_allowed_keys: ["client"] },
  };
  const etag = `sha256:${createHash("sha256").update(canonical(unsigned)).digest("hex")}`;
  return {
    ...unsigned,
    etag,
    signature: `sha256:${createHash("sha256")
      .update(canonical({ application_id: unsigned.application_id, etag }))
      .digest("hex")}`,
  };
}

const acknowledgements = [];
const providerRequests = [];
const usageEvents = [];
let snapshot;

async function readJson(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body.length === 0 ? {} : JSON.parse(body);
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/runtime/snapshot") {
    response.writeHead(200, { "content-type": "application/json", etag: `"${snapshot.etag}"` });
    response.end(JSON.stringify(snapshot));
    return;
  }
  if (request.method === "POST" && request.url === "/runtime/configuration-acknowledgements") {
    acknowledgements.push(await readJson(request));
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: true }));
    return;
  }
  if (request.method === "POST" && request.url === "/usage-events/batch") {
    const batch = await readJson(request);
    usageEvents.push(...batch.events);
    response.writeHead(202, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        schema_version: "2.0",
        batch_id: batch.batch_id,
        received_at: new Date().toISOString(),
        accepted: batch.events.length,
        duplicates: 0,
        conflicts: 0,
        rejected: 0,
        results: batch.events.map((event, index) => ({
          index,
          event_id: event.event_id,
          status: "accepted",
          code: null,
          message: null,
        })),
      }),
    );
    return;
  }
  if (request.method === "POST" && request.url === "/v1/chat/completions") {
    const body = await readJson(request);
    providerRequests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "chatcmpl-example",
        object: "chat.completion",
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "Example response" } }],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      }),
    );
    return;
  }
  response.writeHead(404);
  response.end();
});

await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolvePromise);
});

let directory;
try {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("SDK test server has no port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  snapshot = signedSnapshot(baseUrl);
  directory = await mkdtemp(join(os.tmpdir(), "tokenpilot-sdk-examples-"));
  await chmod(directory, 0o700);
  const noProxy = [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",");
  const environment = {
    ...process.env,
    AI_CONTROL_URL: baseUrl,
    AI_CONTROL_POLICY_API_KEY: "test_policy_key_0000000000000001",
    EXAMPLE_PROVIDER_API_KEY: "provider-test-key",
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };

  const reports = [];
  const nodeLkg = join(directory, "node-runtime.json");
  const nodeResult = await execFileAsync(process.execPath, ["examples/node-sdk/app.mjs"], {
    cwd: resolve("."),
    env: { ...environment, AI_CONTROL_LKG_PATH: nodeLkg },
    timeout: 30_000,
  });
  reports.push(JSON.parse(nodeResult.stdout.trim().split(/\r?\n/u).at(-1)));

  const pythonLkg = join(directory, "python-runtime.json");
  const pythonResult = await execFileAsync(
    "uv",
    ["run", "--project", "sdks/python", "python", "examples/python-sdk/app.py"],
    {
      cwd: resolve("."),
      env: { ...environment, AI_CONTROL_LKG_PATH: pythonLkg, PYTHONPATH: "sdks/python/src" },
      timeout: 60_000,
    },
  );
  reports.push(JSON.parse(pythonResult.stdout.trim().split(/\r?\n/u).at(-1)));

  for (const report of reports) {
    if (
      report.refresh_status !== "updated" ||
      report.runtime_version !== snapshot.version ||
      report.virtual_model !== "customer-support" ||
      report.real_model !== "example-chat-model" ||
      report.attempt_count !== 1
    ) {
      throw new Error(`SDK example returned unexpected evidence: ${JSON.stringify(report)}`);
    }
  }
  for (const lkgPath of [nodeLkg, pythonLkg]) {
    if (((await stat(lkgPath)).mode & 0o777) !== 0o600) {
      throw new Error(`SDK example LKG is not mode 0600: ${lkgPath}`);
    }
  }
  for (const sdk of ["node", "python"]) {
    const states = acknowledgements
      .filter((acknowledgement) => acknowledgement.connector?.name === sdk)
      .map((acknowledgement) => acknowledgement.state);
    if (states.join(",") !== "received,applied") {
      throw new Error(
        `SDK example returned unexpected ACK sequence for ${sdk}: ${states.join(",")}`,
      );
    }
  }
  if (providerRequests.length !== 2 || usageEvents.length !== 2) {
    throw new Error(
      `Expected two Provider requests and two usage events; received ${providerRequests.length} and ${usageEvents.length}.`,
    );
  }
  for (const event of usageEvents) {
    if (
      event.model?.virtual_model !== "customer-support" ||
      event.model?.request_model !== "example-chat-model" ||
      event.usage?.uncached_input_tokens !== "6" ||
      event.usage?.cache_read_input_tokens !== "2" ||
      event.usage?.output_tokens !== "3" ||
      event.usage?.reasoning_output_tokens !== "1" ||
      event.user?.user_id !== "example-user"
    ) {
      throw new Error(`SDK example reported an unexpected event: ${JSON.stringify(event)}`);
    }
  }
  if (JSON.stringify(usageEvents).includes("This content stays in the application request.")) {
    throw new Error("Model request content appeared in a usage event");
  }
  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      examples: ["node", "python"],
      provider_requests: providerRequests.length,
      usage_events: usageEvents.length,
    })}\n`,
  );
} finally {
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
  });
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
}

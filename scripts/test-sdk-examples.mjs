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

const unsignedSnapshot = {
  schema_version: "2.0",
  application_id: "00000000-0000-4000-8000-000000000042",
  version: "runtime-current-example",
  expires_at: "2099-07-16T18:00:00.000Z",
  routing: {
    "text.fast": {
      virtual_model_id: "virtual-model-example",
      configuration_version: 1,
      configuration_etag: `sha256:${"b".repeat(64)}`,
      published_at: "2026-07-16T18:00:00.000Z",
      timezone: "UTC",
      default: {
        route_tag: "cp:text.fast:default",
        selection_mode: "ordered",
        targets: [
          {
            model_id: "00000000-0000-4000-8000-000000000001",
            model_tag: "litellm-example",
            provider: "openai",
            route_tag: "cp:text.fast:default",
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
  dimensions: {
    analytics_allowed_keys: ["client"],
  },
};
const etag = `sha256:${createHash("sha256").update(canonical(unsignedSnapshot)).digest("hex")}`;
const snapshot = {
  ...unsignedSnapshot,
  etag,
  signature: `sha256:${createHash("sha256")
    .update(canonical({ application_id: unsignedSnapshot.application_id, etag }))
    .digest("hex")}`,
};
const acknowledgements = [];

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/runtime/snapshot") {
    response.writeHead(200, { "content-type": "application/json", etag: `"${snapshot.etag}"` });
    response.end(JSON.stringify(snapshot));
    return;
  }
  if (request.method === "POST" && request.url === "/runtime/configuration-acknowledgements") {
    let body = "";
    for await (const chunk of request) body += chunk;
    acknowledgements.push(JSON.parse(body));
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: true }));
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
  directory = await mkdtemp(join(os.tmpdir(), "tokenpilot-sdk-examples-"));
  await chmod(directory, 0o700);
  const noProxy = [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",");
  const environment = {
    ...process.env,
    AI_CONTROL_URL: `http://127.0.0.1:${address.port}`,
    AI_CONTROL_POLICY_API_KEY: "test_policy_key_0000000000000001",
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
      report.sanitized_tags !==
        "caller-visible,cp:text.fast:default,cp:model:00000000-0000-4000-8000-000000000001,cp:configuration:1" ||
      report.governed_context !== true
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
  process.stdout.write(`${JSON.stringify({ status: "passed", examples: ["node", "python"] })}\n`);
} finally {
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
  });
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
}

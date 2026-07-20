#!/usr/bin/env node

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const port = Number.parseInt(process.env.FAKE_PROVIDER_PORT ?? "4100", 10);
const host = process.env.FAKE_PROVIDER_HOST ?? "0.0.0.0";
const maxBodyBytes = 256 * 1024;

function selectors(value) {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

const configuredFailureModels = selectors(process.env.FAKE_PROVIDER_FAIL_MODELS);
const configuredFailureDeployments = selectors(process.env.FAKE_PROVIDER_FAIL_DEPLOYMENTS);

function requestSelectors(value) {
  if (typeof value === "string") return selectors(value);
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((entry) => typeof entry === "string" && entry.length > 0));
}

function selected(set, value) {
  if (value === undefined) return false;
  const unqualified = value.includes("/") ? value.slice(value.lastIndexOf("/") + 1) : value;
  return set.has(value) || set.has(unqualified);
}

function deterministicFailure(request, body) {
  const model = typeof body?.model === "string" ? body.model : undefined;
  const deployment =
    typeof request.headers["x-fake-deployment-id"] === "string"
      ? request.headers["x-fake-deployment-id"]
      : typeof body?.metadata?.fake_deployment_id === "string"
        ? body.metadata.fake_deployment_id
        : undefined;
  const requestModels = requestSelectors(body?.metadata?.fake_failure_models);
  const requestDeployments = requestSelectors(body?.metadata?.fake_failure_deployments);
  return {
    model,
    deployment,
    fail:
      request.headers["x-fake-fail"] === "true" ||
      body?.metadata?.fake_failure === true ||
      selected(configuredFailureModels, model) ||
      selected(configuredFailureDeployments, deployment) ||
      selected(requestModels, model) ||
      selected(requestDeployments, deployment),
  };
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBodyBytes) throw new Error("BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, { status: "healthy", provider: "tokenpilot-fake" });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    json(response, 404, { error: { type: "not_found", message: "Unknown fake endpoint" } });
    return;
  }

  try {
    const body = await readJson(request);
    const failure = deterministicFailure(request, body);
    if (failure.fail) {
      json(response, 503, {
        error: {
          type: "fake_provider_error",
          code: "FAKE_PRIMARY_UNAVAILABLE",
          model: failure.model ?? null,
          deployment_id: failure.deployment ?? null,
        },
      });
      return;
    }
    const model = typeof body?.model === "string" ? body.model : "text.fast";
    json(response, 200, {
      id: `chatcmpl_fake_${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "Synthetic response from the key-free provider." },
        },
      ],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 300,
        total_tokens: 1500,
        prompt_tokens_details: { cached_tokens: 800 },
        completion_tokens_details: { reasoning_tokens: 50 },
      },
    });
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "BODY_TOO_LARGE";
    json(response, tooLarge ? 413 : 400, {
      error: { type: tooLarge ? "body_too_large" : "invalid_json" },
    });
  }
});

server.listen(port, host, () => {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      component: "fake-provider",
      event: "server.started",
      address: `http://${host}:${port}`,
    })}\n`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}

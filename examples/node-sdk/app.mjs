#!/usr/bin/env node

import {
  applyAiContextToOpenAiRequest,
  createAiRuntimeClient,
  withAiContext,
} from "../../sdks/node/dist/index.js";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

const lkgPath = process.env.AI_CONTROL_LKG_PATH ?? ".tokenpilot/node-runtime-snapshot.json";
const client = createAiRuntimeClient({
  controlPlaneUrl: process.env.AI_CONTROL_URL ?? "http://127.0.0.1:4000",
  apiKey: requiredEnvironment("AI_CONTROL_POLICY_API_KEY"),
  lkgPath,
});

const refresh = await client.refresh();
const decorated = await withAiContext(
  {
    userId: "example-user",
    displayUser: "Example User",
    operationId: "example-operation",
    callSource: "node-example",
    userProperties: { member_level: "gold" },
    analyticsDimensions: { client: "node" },
  },
  async () =>
    applyAiContextToOpenAiRequest(
      client,
      {
        model: "text.fast",
        messages: [
          { role: "user", content: "This content goes to LiteLLM, never the Control Plane." },
        ],
        metadata: { cp: { forged: true }, feature: "node-example" },
      },
      { headers: { "x-litellm-tags": "caller-visible,cp:untrusted" } },
    ),
);

process.stdout.write(
  `${JSON.stringify({
    refresh_status: refresh.status,
    runtime_version: refresh.version,
    sanitized_tags: decorated.options.headers["x-litellm-tags"],
    governed_context: decorated.body.metadata?.cp !== undefined,
    lkg_path: lkgPath,
  })}\n`,
);

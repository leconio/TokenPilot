#!/usr/bin/env node

import { createAiRuntimeClient, withAiContext } from "../../sdks/node/dist/index.js";

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

try {
  const refresh = await client.refresh();
  const result = await withAiContext(
    {
      userId: "example-user",
      displayUser: "Example User",
      applicationVersion: "node-example-1.0.0",
      callSource: "node-example",
      eventProperties: { voice_enabled: false, next_action: "confirm" },
      userProperties: { member_level: "gold" },
      analyticsDimensions: { client: "node" },
    },
    () =>
      client.chat({
        model: "customer-support",
        messages: [{ role: "user", content: "This content stays in the application request." }],
      }),
  );

  process.stdout.write(
    `${JSON.stringify({
      refresh_status: refresh.status,
      runtime_version: refresh.version,
      virtual_model: result.virtualModel,
      real_model: result.target.request_model,
      attempt_count: result.attempts.length,
      lkg_path: lkgPath,
    })}\n`,
  );
} finally {
  client.close();
}

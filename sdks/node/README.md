# Node runtime SDK

`@tokenpilot/node-sdk` is the trusted server-side helper for one TokenPilot application. Its runtime
key binds every request to that application. The SDK keeps the last successfully applied routing
configuration, selects a real LiteLLM model for a virtual model, attaches content-free user and
event metadata, and supports strict user AIU reservations.

```ts
import {
  applyAiContextToOpenAiRequest,
  createAiRuntimeClient,
  withAiContext,
} from "@tokenpilot/node-sdk";

const runtime = createAiRuntimeClient({
  controlPlaneUrl: process.env.TOKENPILOT_URL!,
  apiKey: process.env.TOKENPILOT_RUNTIME_KEY!,
  sdkVersion: "0.2.0",
});

await runtime.refresh();
const request = await withAiContext(
  {
    userId: "customer-1",
    displayUser: "Ada",
    applicationVersion: "web-2.8.0",
    sessionId: "session-42",
    callSource: "receipt_parse",
    eventProperties: { voice_enabled: true, next_action: "confirm" },
    userProperties: { member_level: "pro" },
  },
  () => applyAiContextToOpenAiRequest(runtime, { model: "receipt-reader", messages }),
);
```

`userId` is required. Property keys and values are checked locally; content-bearing or credential
fields such as `prompt`, `response`, `messages`, `authorization`, and `api_key` are rejected. The
helper removes caller-supplied TokenPilot metadata and reserved LiteLLM tags before adding its own
envelope. It never copies prompt or response content into that envelope.

The runtime key needs `runtime:read`, `runtime:write`, and `runtime:ack`. Configuration refreshes
report received, applied, or rejected status and retain the last successful configuration on
failure.

Run `pnpm --filter @tokenpilot/node-sdk test` for focused tests.

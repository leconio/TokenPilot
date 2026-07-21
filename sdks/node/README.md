# TokenPilot Node SDK

`@tokenpilot/node-sdk` lets a server application call a stable virtual model while TokenPilot
chooses the real model and connection. It supports LiteLLM, OpenAI-compatible services, Anthropic,
fallbacks, streaming, user AIU limits, configuration refresh, and durable usage reporting.

The SDK sends prompts and responses only to the selected model service. TokenPilot receives model
identity, user context, timing, outcome, and usage counters—not messages, tool arguments, or
Provider credentials.

## Minimal call

Use the application key shown once during Setup. It needs `runtime:read`, `runtime:write`,
`runtime:ack`, and `usage:write`.

```ts
import { createAiRuntimeClient, withAiContext } from "@tokenpilot/node-sdk";

const pilot = createAiRuntimeClient({
  controlPlaneUrl: process.env.TOKENPILOT_URL!,
  apiKey: process.env.TOKENPILOT_APPLICATION_KEY!,
  // Keys are looked up by each connection's credential reference.
  credentials: { OPENAI_API_KEY: process.env.OPENAI_API_KEY! },
});

await pilot.start(); // Loads now and refreshes future requests in the background.

const result = await withAiContext(
  {
    userId: "customer-42",
    displayUser: "Ada",
    applicationVersion: "web-2.8.0",
    callSource: "receipt_parse",
    eventProperties: { voice_enabled: false, next_action: "confirm" },
    userProperties: { member_level: "pro" },
  },
  () =>
    pilot.chat({
      model: "customer-support", // Virtual model, not a Provider model name.
      messages: [{ role: "user", content: "The request content stays here." }],
    }),
);

console.log(result.target.request_model, result.attempts);
await pilot.flushUsage();
pilot.close();
```

Call `chatStream()` for an `AsyncIterable`. Pass an `AbortSignal` to either call to propagate user
cancellation. In hard-limit mode, also pass a conservative `estimatedAiuMicros`; final rated AIU is
reconciled by the processing pipeline.

## Existing Provider clients

Register an adapter by connection ID when an application already has an official SDK client,
custom proxy, connection pool, or enterprise retry policy. The adapter receives the selected real
model and can return normalized usage plus the actual amount charged for that attempt:

```ts
return {
  response,
  usage: { uncached_input_tokens: "820", output_tokens: "91" },
  sourceCost: { amount: "0.00472", currency: "USD", isEstimated: false },
};
```

Registering by connection ID takes precedence over a driver-wide adapter. Streaming adapters can
attach `sourceCost` to the part where the final amount becomes available.

Use `recordUsage()` for a service without a full adapter. It still requires an active user context,
a published virtual model, a valid candidate real-model ID, and caller-generated idempotency IDs.
Pass `sourceCost` there when the service exposes an amount. It cannot bypass application isolation
or report message content. Reported cost takes precedence over Web fallback rules and does not
change AI Unit conversion.

## Reliability and privacy

- `start()` uses ETag refresh and keeps a signed last-known-good file.
- Usage first enters a bounded SQLite spool and is safely replayed after an outage.
- `userId` is required; `displayUser` is recommended.
- Define custom fields in the Web console before sending them. Reserved content and credential keys
  are rejected locally.
- Credentials come from the `credentials` map, a `credentialResolver`, or the process environment.
  Published configuration contains references only.

## Verify

```bash
pnpm --filter @tokenpilot/node-sdk typecheck
pnpm --filter @tokenpilot/node-sdk test:coverage
```

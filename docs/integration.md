# Application integration

[中文](integration.zh-CN.md)

TokenPilot supports three equal paths: the Node SDK, the Python SDK, and the LiteLLM Connector.
They read the same published virtual-model policy and send the same content-free usage event. Pick
the path already closest to the application; reports and AIU calculations do not change.

## 1. Prepare the application

Complete first-run Setup, select the application, and keep the generated application key. The key
is displayed once and includes the scopes needed to read and acknowledge runtime configuration,
reserve AIU, send Connector heartbeats, and upload usage. A key is bound to one application; never
share it across applications or put an `application_id` in reported events.

In **Models**, configure in this order:

1. Add a call connection: LiteLLM, OpenAI-compatible service, or Anthropic.
2. Set a credential reference such as `OPENAI_API_KEY`. This is a local lookup name, not a secret.
3. Add real models. Each record binds one connection to the model name sent to that service.
4. Add Provider-cost and AI Unit prices to each real model.
5. Create a virtual model such as `customer-support`, arrange preferred and fallback models, and
   add schedule or user conditions if needed.
6. Publish. The release page returns all validation problems together.

Provider credentials are configured only in the application or LiteLLM process. TokenPilot never
asks for them and published configuration never contains them.

## 2. Node SDK

```ts
import { createAiRuntimeClient, withAiContext } from "@tokenpilot/node-sdk";

const pilot = createAiRuntimeClient({
  controlPlaneUrl: process.env.TOKENPILOT_URL!,
  apiKey: process.env.TOKENPILOT_APPLICATION_KEY!,
  instanceId: "orders-node-1",
  credentials: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
  },
});

await pilot.start();

const answer = await withAiContext(
  {
    userId: "customer-42",
    displayUser: "Ada",
    applicationVersion: "orders-2026.07",
    callSource: "support_reply",
    eventProperties: { voice_enabled: false, next_action: "review" },
    userProperties: { member_level: "gold", parse_context: "support" },
  },
  () =>
    pilot.chat({
      model: "customer-support",
      messages: [{ role: "user", content: "This text is sent only to the model service." }],
    }),
);

console.log(answer.target.request_model);
pilot.close();
```

Use `chatStream()` for streaming and pass `signal` for cancellation. If the application already
owns an official SDK client, register an adapter by connection ID to reuse its proxy, pool, and
retry settings. See [`sdks/node/README.md`](../sdks/node/README.md).

## 3. Python SDK

```python
import os

from ai_control_sdk import AiRuntimeClient, AiRuntimeContext, ai_context

pilot = AiRuntimeClient(
    control_plane_url=os.environ["TOKENPILOT_URL"],
    api_key=os.environ["TOKENPILOT_APPLICATION_KEY"],
    instance_id="orders-python-1",
    credentials={
        "OPENAI_API_KEY": os.environ["OPENAI_API_KEY"],
        "ANTHROPIC_API_KEY": os.environ["ANTHROPIC_API_KEY"],
    },
)
pilot.start()

with ai_context(
    AiRuntimeContext(
        user_id="customer-42",
        display_user="Ada",
        application_version="orders-2026.07",
        call_source="support_reply",
        event_properties={"voice_enabled": False, "next_action": "review"},
        user_properties={"member_level": "gold", "parse_context": "support"},
    )
):
    answer = pilot.chat(
        model="customer-support",
        messages=[{"role": "user", "content": "This text is sent only to the model service."}],
    )

print(answer.target.request_model)
pilot.close()
```

`AsyncAiRuntimeClient` provides asynchronous calls and streams. Existing Provider clients can be
wrapped in a connection adapter. See [`sdks/python/README.md`](../sdks/python/README.md).

## 4. LiteLLM Connector

Install `connectors/litellm` in the same Python environment as LiteLLM and register
`deploy/litellm/ai_control_callback.py` as the shared, success, and failure callback.

```dotenv
AI_CONTROL_URL=https://tokenpilot.example.com
AI_CONTROL_API_KEY=<application-key>
AI_CONTROL_POLICY_API_KEY=<same-application-key>
AI_CONTROL_CONNECTOR_INSTANCE_ID=litellm-production-01
AI_CONTROL_SPOOL_PATH=/var/lib/tokenpilot/litellm-spool.sqlite3
AI_CONTROL_POLICY_LKG_PATH=/var/lib/tokenpilot/runtime-configuration.json
AI_CONTROL_POLICY_REQUIRED=true
AI_CONTROL_POLICY_POLL_INTERVAL_SECONDS=5
```

```yaml
litellm_settings:
  callbacks:
    - ai_control_callback.proxy_handler_instance
  success_callback:
    - ai_control_callback.proxy_handler_instance
  failure_callback:
    - ai_control_callback.proxy_handler_instance
```

Application code still calls the virtual model:

```python
response = await litellm.acompletion(
    model="customer-support",
    messages=[{"role": "user", "content": prompt}],
    metadata={
        "cp": {
            "user_id": "customer-42",
            "display_user": "Ada",
            "application_version": "orders-2026.07",
            "event_properties": {"next_action": "review", "voice_enabled": False},
            "user_properties": {"member_level": "gold", "parse_context": "support"},
        }
    },
)
```

Do not duplicate business routing in LiteLLM YAML. TokenPilot owns the preferred model, weights,
conditions, and fallback order; the Connector translates each published real model's
`request_model` only when the selected connection is LiteLLM.

Persist the spool and last-known-good directories. An invalid update is rejected atomically and the
last valid policy continues to serve requests. With `AI_CONTROL_POLICY_REQUIRED=true`, requests
fail closed when neither current nor unexpired last-known-good configuration is available.

## Users and custom fields

Every model operation requires `user_id`; `display_user` is recommended. The first accepted event
creates that user inside the current application. Later events can update the display name and
typed user properties.

Define custom fields in **Settings → Fields** before reporting them. Event fields describe one
operation, such as `voice_enabled` or `next_action`; user fields describe the application user,
such as `member_level` or `parse_context`. Supported analytical types are text, number, boolean,
time, enum, and text list. Undeclared or invalid fields are rejected or dropped according to the
application policy; reserved content and credential keys are always rejected.

## Quota and settlement

In hard-limit mode, the runtime reserves a conservative estimated amount before any Provider call.
A blocked application user or insufficient quota stops the call before model cost is created.
Success reports the reservation ID with measured usage; the processing pipeline rates the actual
real model and reconciles the estimate to final AIU. Failure or cancellation releases the unused
reservation. All transitions and event replays are idempotent.

## Configuration changes without redeploying

`start()` polls with ETag and applies only signed, application-bound configuration. When a newly
published policy moves `customer-support` from LiteLLM to a registered direct connection, the next
request uses that connection without changing the virtual model name or restarting the process.
Introducing a new Provider still requires its credential reference or client to be configured in
the application before publishing a route to it.

## Manual usage reporting

Use SDK `recordUsage` / `record_usage` only for a service that cannot yet use a full adapter. The
caller supplies stable event and attempt IDs, measured counters, a virtual model, and a candidate
real-model ID. The SDK still enforces the active application user, published route, privacy
allowlist, and durable spool.

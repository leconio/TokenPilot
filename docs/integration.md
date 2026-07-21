# Application integration

[中文](integration.zh-CN.md)

Choose the Node SDK, Python SDK, or LiteLLM Connector. All three read the same virtual-model policy
and report the same usage fields. The reports and AI Unit calculations are the same for each path.

## 1. Prepare the application

Complete first-run Setup, select the application, and save the generated application key. It is
shown once and has the permissions required for configuration, AIU reservation, Connector status,
and usage upload. The key belongs to one application. Do not share it across applications or add
`application_id` to reported events.

In **Models**, configure in this order:

1. Add a call connection: LiteLLM, OpenAI-compatible service, or Anthropic.
2. Set a credential reference such as `OPENAI_API_KEY`. This is a local lookup name, not a secret.
3. Add real models. Each record binds one connection to the model name sent to that service.
4. Publish AI Unit rates. Add conditional cost fallbacks only where callers cannot report cost.
5. Create a virtual model such as `customer-support`, arrange preferred and fallback models, and
   add schedule or user conditions if needed.
6. Publish. The release page returns all validation problems together.

Keep provider credentials in the application or LiteLLM process. TokenPilot does not request or
publish their values.

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

Persist the spool and last-valid-policy directories. If an update is invalid, the Connector keeps
the previous policy. With `AI_CONTROL_POLICY_REQUIRED=true`, it rejects requests when it has neither
a current policy nor an unexpired saved policy.
LiteLLM's `response_cost` is reported as the attempt's source cost when it is available.

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

In hard-limit mode, the runtime reserves an estimated amount before the provider call. A blocked
user or insufficient allowance stops the call before it creates model cost. On success, the event
includes the reservation ID and measured usage; the Worker settles the estimate to final AIU.
Failure or cancellation releases the unused reservation. These operations can be retried safely.

## Configuration changes without redeploying

`start()` checks for updates with ETag and accepts only signed configuration for the current
application. If a new policy moves `customer-support` from LiteLLM to a registered direct
connection, the next request uses it without a restart or code change. Before adding a new provider
to a route, configure its credential reference or client in the application.

## Manual usage reporting

Use SDK `recordUsage` / `record_usage` only for a service that cannot yet use a model adapter. The
caller supplies stable event and attempt IDs, measured counters, a virtual model, and a candidate
real-model ID. Include `sourceCost` in Node or `SourceCost` in Python when the service returns an
actual or estimated amount. The SDK still enforces the active application user, published route,
privacy allowlist, and durable spool. A reported amount takes precedence over cost fallback rules;
AI Unit is still calculated independently from usage.

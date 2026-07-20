# First application tutorial

[中文](tutorial.zh-CN.md)

This tutorial takes a new installation from an empty console to one application, a directly called
model with fallback, content-free reporting, cost and AI Unit analytics, and a user allowance. The
Node and Python examples run natively on macOS and do not need a local container runtime.

## 1. Finish setup and create an application

Open the Web console and complete first-run setup. TokenPilot creates the administrator and a first
application, plus one application key with the permissions needed by the SDKs and Connector. Copy
the key immediately; its raw value cannot be displayed again.

Create another application from the application switcher when needed. Applications do not share
users, reports, fields, quotas, or routing publications.

For a disposable environment, the optional example seed adds two secret-free connections, two real
models, and a fallback virtual model to an application that already exists:

```bash
TOKENPILOT_EXAMPLE_APPLICATION_SLUG='my-application' \
  pnpm --filter @tokenpilot/db db:seed:example
```

The regular `db:seed` never adds product data. The example command stores environment-variable
names, not credential values, and is safe to run more than once.

## 2. Define reportable fields

Open **Fields** and add only the product dimensions you intend to search or report:

| Scope | Field           | Type    |
| ----- | --------------- | ------- |
| Event | `next_action`   | text    |
| Event | `voice_enabled` | boolean |
| User  | `parse_context` | text    |
| User  | `voice_type`    | text    |

Mark sensitive dimensions as sensitive. Undefined fields and values of the wrong type are rejected,
which keeps searches and saved reports trustworthy. Prompts and model responses are not custom
fields and must not be reported.

## 3. Add a connection and real models

Open **Models → Connections** and add an OpenAI-compatible connection. Enter its endpoint and the
name of an environment variable such as `OPENAI_API_KEY`; enter the actual credential only in the
SDK process environment. Use **Check connection** after that environment is available to the
runtime.

Open **Models → Real models** and add a model on the connection. Its request name is the exact model
identifier expected by the Provider. Add a second real model if you want to exercise fallback.

For each real model, publish Provider cost and AI Unit rates for the usage lines you expect. Input,
output, cache, reasoning, image, audio, and other supported units can use different rates.

## 4. Create and publish a virtual model

Open **Virtual models** and create a short stable name such as `support-chat`. Add the primary real
model followed by the fallback. Optional conditions can select candidates by time, user, user
group, or a temporary override. Use **Simulate** with a representative user and input type, resolve
all validation messages, then publish.

The release is active only after the target runtime acknowledges the exact revision. A rejected
configuration remains visible with all validation reasons, and the last applied revision remains in
use.

## 5. Call the virtual model from an SDK

Build the Node SDK, then run the example with the control URL, application key, application slug,
and the Provider credential named in the connection:

```bash
pnpm --filter @tokenpilot/node-sdk build
AI_CONTROL_URL=http://127.0.0.1:4000 \
AI_CONTROL_POLICY_API_KEY='the-one-time-application-key' \
AI_CONTROL_APPLICATION_SLUG='my-application' \
OPENAI_API_KEY='provider-key' \
node examples/node-sdk/app.mjs
```

The Python SDK follows the same virtual-model contract:

```bash
PYTHONPATH=sdks/python/src \
AI_CONTROL_URL=http://127.0.0.1:4000 \
AI_CONTROL_POLICY_API_KEY='the-one-time-application-key' \
AI_CONTROL_APPLICATION_SLUG='my-application' \
OPENAI_API_KEY='provider-key' \
uv run --project sdks/python python examples/python-sdk/app.py
```

The SDK downloads the published candidates, reserves AI Unit when enforcement is enabled, calls the
real model, falls back only when allowed, settles actual usage, and queues one content-free event
per attempt. See [Integration guide](integration.md) for complete code and adapter examples.

If the application already uses LiteLLM, use the separate
[`litellm-local`](../examples/litellm-local/README.md) example. It exercises the same reporting and
published virtual-model behavior without moving Provider credentials into TokenPilot.

## 6. Verify users and analytics

Open **Users**. The reported `user_id` now exists automatically and `display_user` is shown as its
human name. You can also add a user manually with only `user_id`.

Check **Usage**, **Model cost**, and **AI Unit**. Combine filters for the example user, virtual model,
real model, attempt result, and a custom field. The event detail should show token lines, the full
fallback chain, route reason, cost, AI Unit, and typed properties, but no prompt or response text.
Save the analysis and add it to the current application's dashboard.

## 7. Exercise allowance control

Grant the example user an AI Unit allowance. In enforcement mode, the SDK reserves an estimate
before any Provider call, settles it to the final rated amount on success, and releases it when the
request cannot start. Resetting allowance appends an audited adjustment instead of deleting
history. Blocking the user prevents later calls after the updated runtime policy is applied.

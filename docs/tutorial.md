# First application tutorial

[中文](tutorial.zh-CN.md)

This tutorial configures one application, calls a virtual model with fallback, checks cost and AI
Unit reports, and sets a user allowance. The Node and Python examples run on macOS without a local
container runtime.

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

Open **Fields** and add only values that you plan to search or use in a report:

| Scope | Field           | Type    |
| ----- | --------------- | ------- |
| Event | `next_action`   | text    |
| Event | `voice_enabled` | boolean |
| User  | `parse_context` | text    |
| User  | `voice_type`    | text    |

Mark sensitive fields as sensitive. TokenPilot rejects undefined fields and values of the wrong
type. Do not report prompts or model responses as custom fields.

## 3. Add a connection and real models

Open **Models → Connections** and add an OpenAI-compatible connection. Enter its endpoint and the
name of an environment variable such as `OPENAI_API_KEY`; enter the actual credential only in the
SDK process environment. Use **Check connection** after that environment is available to the
runtime.

Open **Models → Real models** and add a model on the connection. Its request name is the exact model
identifier expected by the Provider. Add a second real model if you want to exercise fallback.

For each real model, publish its AI Unit rates. Provider amounts reported by the SDK or Connector
need no price setup. If a caller cannot report cost, add ordered fallback rules and match them by
built-in fields or typed properties. A fallback can combine a fixed call amount with per-unit input,
output, cache, reasoning, image, audio, or custom amounts.

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

The SDK downloads the published candidates and checks the allowance. It calls the selected real
model, tries the next allowed candidate after a supported failure, settles actual usage, and queues
one usage event per attempt. See the [integration guide](integration.md) for more code and
adapter examples.

If the application already uses LiteLLM, use the separate
[`litellm-local`](../examples/litellm-local/README.md) example. It exercises the same reporting and
published virtual-model behavior without moving Provider credentials into TokenPilot.

## 6. Verify users and analytics

Open **Users**. The reported `user_id` appears automatically, and `display_user` is its name in the
console. You can also add a user manually with only `user_id`.

Check **Usage**, **Model cost**, and **AI Unit**. Combine filters for the example user, virtual model,
real model, attempt result, and a custom field. The event detail should show token lines, the full
fallback chain, route reason, cost, AI Unit, and typed properties, but no prompt or response text.
Save the analysis and add it to the current application's dashboard.

## 7. Exercise allowance control

Grant the example user an AI Unit allowance. In enforcement mode, the SDK reserves an estimate
before any Provider call, settles it to the final rated amount on success, and releases it when the
request cannot start. Resetting allowance appends an audited adjustment instead of deleting
history. Blocking the user prevents later calls after the updated runtime policy is applied.

# First application tutorial

[中文](tutorial.zh-CN.md)

This tutorial takes a new installation from an empty console to a real LiteLLM call, content-free
usage reporting, model cost and AIU analytics, user quota, and published routing. The Mac example
runs as native Python and never needs a local container runtime.

## 1. Create the application and keys

Complete first-run setup, then create an application with only a name. TokenPilot derives the URL
slug. In **Settings → Access keys**, create three separate application keys:

- usage and Connector heartbeat;
- runtime configuration and AIU reservation;
- report read access for verification.

Copy each key immediately; raw values cannot be displayed again.

## 2. Define fields

Open **Fields** and add these examples:

| Scope | Field           | Type    |
| ----- | --------------- | ------- |
| Event | `next_action`   | text    |
| Event | `voice_enabled` | boolean |
| User  | `parse_context` | text    |
| User  | `voice_type`    | text    |

Keep sensitive fields marked sensitive. Undefined fields and values of the wrong type are rejected,
which keeps searches and reports trustworthy.

## 3. Register models and rates

Open **Models**. A model needs only a display name and its exact LiteLLM name. For the included
native example, register:

- `openai/local-success`;
- `openai/local-primary`;
- `openai/local-fallback`.

Open each model and enter Provider cost and AIU conversion rates for the usage lines you expect.
AIU binds directly to this model; input, output, cache, reasoning, image, audio, and other supported
units may have different conversion rates.

## 4. Create and publish a virtual model

Open **Virtual models**, create a stable name used by application code, and add the primary model
followed by the fallback. Optional conditions can select candidates by time, user, user group, or a
temporary override. Use **Simulate** with a representative user, then publish in **Releases**.

The release is considered active only after the target Connector reports that it applied the exact
configuration version. A rejected configuration remains visible with its reason.

## 5. Run the Mac-native LiteLLM example

From the repository root:

```bash
cd examples/litellm-local
cp .env.example .env
# Fill the three application keys and application slug.
uv sync --all-groups
uv run python app.py
uv run python verify_reporting.py
```

The example starts an OpenAI-compatible fake Provider, uses a real LiteLLM Router, records one
successful call and one primary-failure/fallback call, and reports them through the durable
Connector spool. Its `.env.example` already shows the optional LAN proxy settings.

## 6. Verify users and analytics

Open **Users**. The reported `user_id` now exists automatically and its recommended
`display_user` is shown. You can also add another user manually with only `user_id`; users are
isolated to this application.

Then check **Usage**, **AI cost**, and **AIU**. Filter by the example user and model. The event detail
should show token lines, actual fallback model, route reason, cost, AIU, and typed properties, but no
prompt or response text. Save the analysis and add it to the application's dashboard.

## 7. Exercise quota control

Set an AIU quota for the example user. In strict mode, a trusted runtime reserves AIU before the
call, settles actual use on success, and releases on failure. Resetting quota appends an audited
adjustment instead of deleting history. Blocking the user is published in the runtime snapshot and
prevents later calls while the last successfully applied configuration remains available.

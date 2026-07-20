# Project guide

[中文](guide.zh-CN.md)

## The problem TokenPilot solves

An AI application usually starts with one model name and one Provider key. As it grows, the team
needs stable answers to questions that individual Provider dashboards cannot answer:

- Which application, feature, and user consumed the tokens?
- How much did every attempt cost, including failed primary attempts before a fallback?
- How can application code keep one model name while Providers and model versions change?
- How can different model usage types become one product-defined AI Unit?
- How much AI Unit remains for a user, and how can concurrent calls respect that allowance?

TokenPilot gives teams one place to define these rules. Applications can call models through the
TokenPilot Node or Python SDK, continue using LiteLLM, or report calls made by another client. The
SDKs and LiteLLM Connector send content-free attempt events and keep a local durable queue during a
temporary outage. Published routing is cached locally, so an already applied policy remains usable
if the control service is briefly unavailable.

## The main product areas

### Applications and users

Every application has an independent home page, user list, fields, access keys, reports, quotas,
and published routing state. A call must provide `user_id`; `display_user` is the recommended human
name. New users can be discovered from calls or added in the console. Typed custom fields support
product-specific dimensions such as `next_action`, `parse_context`, and voice mode without sending
prompts or responses.

### Connections and real models

A **connection** tells a trusted runtime how to reach a model service. It records the protocol,
endpoint, capabilities, and the environment-variable name that contains the credential; TokenPilot
does not store the credential value. A **real model** is a callable Provider model on that
connection. Its request name, Provider cost rates, and AI Unit conversion rates live together.

### Virtual models and routing

A **virtual model** is the stable name used by application code, such as `fast-text` or
`deep-reasoning`. Its candidates point to real models and can express default order, fallback,
time windows, user or user-group conditions, and temporary overrides. Publishing creates an
immutable revision. Trusted runtimes download and validate it, then acknowledge the exact revision
they applied.

Applications therefore keep requesting the same virtual model while the real Provider or model can
change through a published policy. A call that includes image or audio input only considers
candidates that declare the corresponding capability.

### Analytics and saved reports

The console shows calls, attempt chains, token lines, latency, errors, Provider cost, AI Unit usage,
and configuration coverage. Filters can combine time, application, user, user tags, virtual model,
real model, Provider, custom fields, and result. Saved analyses can be added to each application's
dashboard. Reports always read ClickHouse; PostgreSQL stores configuration and operational state.

### Provider cost, AI Unit, and user allowance

Provider cost answers how much the model service charged. AI Unit is the product-defined unit used
to measure and grant model usage. Input, output, cache, reasoning, image, audio, and other supported
usage lines can have different rates on each real model. Both calculations preserve the exact
published rate snapshot used for the event. Missing coverage is shown as unpriced or unrated usage,
never silently converted to zero.

Each application user can receive an AI Unit allowance. Enforcement reserves a conservative amount
before a call, settles it to the actual rated usage afterward, and releases it when no attempt is
made. Blocking and allowance resets are explicit, audited operations; history is not deleted.

## Privacy and reliability boundaries

- TokenPilot needs messages only in the calling process to invoke the Provider; reporting excludes
  prompt and response bodies.
- Provider credentials stay in runtime environment variables or the team's existing secret store.
- SQLite-backed SDK and Connector queues retry content-free events with stable identifiers.
- PostgreSQL and ClickHouse are both required: they have distinct configuration and analytics jobs.
- A rejected publication never replaces the last successfully applied policy.

## Recommended adoption path

1. Deploy TokenPilot and complete first-run setup.
2. Create an application and its application key.
3. Define the event and user fields that the application is allowed to report.
4. Add a connection and its real models, then publish complete cost and AI Unit rates.
5. Create a virtual model, simulate representative requests, and publish it.
6. Integrate the Node SDK, Python SDK, or LiteLLM Connector and verify a real call.
7. Review users, attempt chains, cost, AI Unit, and saved reports.
8. Grant user allowances in measurement mode, then enable warnings or enforcement after identity
   and rate coverage are complete.

This sequence keeps the first integration observable and easy to correct without treating missing
data as valid data.

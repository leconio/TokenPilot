# Project guide

[中文](guide.zh-CN.md)

## The problem TokenPilot solves

An AI application usually starts with one model and one API key. As it grows, the team has to answer
questions that Provider dashboards cannot answer reliably:

- Which product feature, customer, or route consumed the tokens?
- What did a fallback attempt cost even though the final request failed?
- Which public model name should the application use when Providers and model versions change?
- How can different model costs become one stable product usage unit?
- How much usage remains for a user, and can the answer be enforced without races?

TokenPilot keeps these concerns outside the model request path. LiteLLM continues to own Provider
credentials, retries, and model traffic. TokenPilot receives a content-free event after an attempt,
processes it durably, and publishes a compact routing policy that trusted SDKs can cache.

## The four product areas

### Analytics

The Web console shows model calls, token lines, latency, errors, provider cost, AI Unit usage, and
coverage gaps. Filters can combine time, user, virtual model, real model, Provider, application tag,
and result. Reports always read ClickHouse; they never switch to a slower PostgreSQL report path.

### Model configuration and routing

A **model** is the real LiteLLM model name used for cost and AI Unit rates. A **virtual model** is the
stable name used by the application, such as `fast-text` or `deep-reasoning`. Its routing contains a default candidate, fallback order,
schedule rules, and optional temporary overrides. Publishing creates an immutable policy revision.

### Provider cost and AI Unit

Provider cost answers how much the model service charged. AI Unit answers how much product-defined
usage occurred. They are separate calculations and each stores the exact published rate snapshot
used for a decision. A missing rate is visible as unpriced or unrated usage; it is never converted to
zero.

### User quota

AI Unit can be measured without blocking calls, shown as a warning, or enforced as a hard limit.
Hard-limit mode uses signed reservations so concurrent requests cannot spend the same remaining
quota. Successful calls settle the reservation, cancelled calls release it, and abandoned
reservations expire.

## What TokenPilot deliberately does not do

- It does not proxy or transform model requests.
- It does not store Provider credentials.
- It does not need prompt or response bodies.
- It does not replace a product's own customer and payment systems.
- It does not run with only one database; all required stores must be healthy.

## Typical adoption path

1. Deploy TokenPilot with all three data services.
2. Connect LiteLLM in measurement mode.
3. Register every LiteLLM model name used by real requests.
4. Publish complete Provider cost and AI Unit rates.
5. Review coverage and analytics.
6. Create stable virtual model names and publish routing configuration.
7. Add user quotas in measure-only mode.
8. Enable warnings or enforcement only after rate and identity coverage are complete.

This order keeps the first integration observable and reversible without pretending that missing
data is valid data.

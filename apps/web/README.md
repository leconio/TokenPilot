# Web administration console

The Next.js App Router console administers multiple isolated applications. It is not a
model gateway and never receives Provider credentials, prompts, responses, or model traffic.

## Run

Start PostgreSQL, ClickHouse, Redis, the API, and then the Web process. PostgreSQL and ClickHouse
are both required; the console does not offer a single-database or fallback mode. The Web server proxies same-origin
requests under `/api/control/*` to the internal API, preserving the session cookies and CSRF header.

```bash
API_INTERNAL_URL=http://127.0.0.1:4000 pnpm --filter @tokenpilot/web dev
```

Open `http://127.0.0.1:3000/setup` for the first run. Setup:

1. verifies that PostgreSQL and ClickHouse are both healthy;
2. creates the first application with its timezone and base currency;
3. creates the only initial administrator and a hashed eight-hour session;
4. issues isolated ingest and configuration keys exactly once;
5. shows the privacy-safe LiteLLM Connector configuration; and
6. opens the application dashboard so models and virtual models can be configured.

After the administrator exists, setup initialization returns `409` and the page redirects to login.
Provider keys remain environment-variable references in LiteLLM; only names such as
`OPENAI_API_KEY` can be stored as `secret_ref` metadata.

## Routes

- `/apps/:slug/dashboard`: model spend, AIU used, users approaching their AIU limit, publication state,
  service health, and shortcuts to the main tasks.
- `/apps/:slug/ai-units`, `/apps/:slug/costs`: separate AIU and model-spend dashboards plus self-service analysis. Users
  choose a metric, time range, whether to match all or match any conditions, and optional grouping,
  then export the result. These reports use the single ClickHouse report path and never fall back to
  PostgreSQL.
- `/apps/:slug/models`: register LiteLLM model names and maintain independent provider cost and AIU
  conversion rates in each model detail page.
- `/apps/:slug/virtual-models`: configure user-facing virtual models, candidates, fallback order,
  schedules, temporary switches, and routing tests in one place.
- `/apps/:slug/releases`: publish the application configuration distributed to LiteLLM.
- `/apps/:slug/users`: inspect application users, AIU quota, used and remaining amounts, then reset
  quota or stop calls for an individual user.
- `/apps/:slug/user-groups`: build reusable audiences from user attributes and measured usage.
- `/apps/:slug/properties`: define typed event fields and user attributes for ingestion and analysis.
- `/apps/:slug/usage`: search content-free events with match all or match any conditions and open
  redacted details.
- `/apps/:slug/reports`: save reusable analyses and place them on the application dashboard.
- `/apps/:slug/connectors`, `/apps/:slug/audit`, `/apps/:slug/settings`: inspect service connections, operation history, basic
  settings, one-time access keys, privacy controls, and collapsed advanced diagnostics.

The shell uses the same compact Chinese navigation on desktop and mobile. Technical identifiers,
versions, storage names, and other diagnostic fields stay out of the normal task flow and appear
only in the advanced details that need them.

## Security boundary

- Session tokens are random, stored only as SHA-256 hashes, and sent in `HttpOnly`, `SameSite=Strict`
  cookies (`Secure` in production).
- Browser mutations require the matching CSRF cookie/header and an allowed Origin.
- CSP, HSTS, frame denial, MIME sniffing protection, referrer policy, and restrictive permissions
  policy are emitted by Next.js.
- Raw event views receive a server-redacted object and apply a second recursive browser-side mask.
- Model-spend values remain decimal strings; `decimal.js` is used for display-side aggregation and
  ordering. JavaScript floating point never determines a cost value.

Report responses contain one ClickHouse result plus `watermark`, `lag_seconds`, and the requested
time range. The console has no source selector or source badge. If either required datastore is
unavailable, report pages show an unavailable state and do not substitute PostgreSQL rows or zeros.

## Verify

```bash
pnpm --filter @tokenpilot/web typecheck
pnpm --filter @tokenpilot/web build
PLAYWRIGHT_PORT=3101 pnpm --filter @tokenpilot/web test:e2e
```

Playwright covers setup, model and AIU configuration, routing publication, analysis, user quota,
and access-key revocation at desktop and 390-pixel mobile widths, including recoverable failures,
confirmations, audit reasons, redaction, and horizontal-overflow checks.

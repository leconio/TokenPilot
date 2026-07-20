# Runnable examples

All examples are key-free with respect to model Providers. Control-plane Service API Keys are still
required for authenticated ingestion or Policy pulls and must be supplied through environment
variables, never committed.

For the complete native macOS LiteLLM reporting flow, including a Python fake model, fallback,
typed user/event fields, and ClickHouse verification, see
[`litellm-local`](./litellm-local/README.md).

## Fake OpenAI-compatible Provider

```bash
node examples/fake-provider/server.mjs
curl -sS http://127.0.0.1:4100/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"text.fast","messages":[{"role":"user","content":"hello"}]}'
```

Use `x-fake-fail: true` to return a deterministic 503 and exercise LiteLLM fallback. The process
never logs request bodies.

## Usage generator

Print a Contract-valid event batch, write it mode 0600, or upload it directly:

```bash
node examples/usage-generator/generate.mjs --scenario peak --count 1
node examples/usage-generator/generate.mjs --scenario offpeak --count 500 --output /tmp/events.json
AI_CONTROL_URL=http://127.0.0.1:4000 \
AI_CONTROL_INGEST_API_KEY='the-one-time-ingest-key' \
  node examples/usage-generator/generate.mjs --scenario fallback --count 2
```

Fixed seeds make retries produce the same `event_id`, which demonstrates ingestion and usage-processing
idempotency. Change `--seed` when a genuinely new batch is required.

## Node and Python Policy SDKs

Build first, then pass the one-time Policy API Key:

```bash
pnpm --filter @tokenpilot/node-sdk build
AI_CONTROL_POLICY_API_KEY='the-one-time-policy-key' node examples/node-sdk/app.mjs

PYTHONPATH=sdks/python/src AI_CONTROL_POLICY_API_KEY='the-one-time-policy-key' \
  uv run --project sdks/python python examples/python-sdk/app.py
```

For the default `Asia/Shanghai` instance timezone, set
`ROUTE_INSTANT=2026-07-14T18:00:00Z` (local `2026-07-15 02:00`) to exercise a deterministic off-peak
decision. `2026-07-15T02:00:00Z` is local 10:00 and therefore exercises the peak rule. Both examples
strip caller-supplied `cp:*` tags and keep using an atomic local LKG during a Control Plane outage.

## Connector outage and recovery

Against a running Control Plane, this script first uploads to an intentionally offline address,
closes/reopens the SQLite spool to simulate a process restart, then delivers once to the real API:

```bash
AI_CONTROL_URL=http://127.0.0.1:4000 \
AI_CONTROL_INGEST_API_KEY='the-one-time-ingest-key' \
  uv run --project connectors/litellm python examples/connector-recovery/demo.py
```

Re-running with the same `--call-id` exercises server-side duplicate acknowledgement. Use
`--spool /persistent/path/demo.sqlite3` to inspect the WAL-backed file after the run.

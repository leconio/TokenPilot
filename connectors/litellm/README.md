# LiteLLM usage connector

The Python 3.12 connector captures LiteLLM's Standard Logging Payload after both successful and
failed Provider attempts. The callback constructs the canonical content-free Usage Event and commits
it to a local SQLite WAL spool. Daemon workers upload gzip batches and heartbeats separately, so an
upload outage does not delay or fail a completed model request. Pre-call routing and strict quota
checks follow the fail-open or fail-closed settings described below.

```text
LiteLLM callback -> allowlist/map -> SQLite WAL -> batch+gzip sender -> Control Plane API
                                      |
                                      +-> retry with jitter / rejected archive
```

## Install

Install the package into the same Python environment as LiteLLM Proxy:

```bash
uv pip install -e connectors/litellm
```

Copy [`deploy/litellm/config.example.yaml`](../../deploy/litellm/config.example.yaml) and set the
connector environment. `AI_CONTROL_API_KEY` is the usage-ingestion key and
`AI_CONTROL_POLICY_API_KEY` is the separate policy/runtime key; neither is a Provider key.
Installing or upgrading the Connector does not change LiteLLM Provider keys or its master key.

| Variable                                  | Default                             | Purpose                                                 |
| ----------------------------------------- | ----------------------------------- | ------------------------------------------------------- |
| `AI_CONTROL_URL`                          | `http://127.0.0.1:4000`             | Control Plane base URL                                  |
| `AI_CONTROL_API_KEY`                      | unset                               | Bearer key with `usage:write` and `connector:heartbeat` |
| `AI_CONTROL_POLICY_API_KEY`               | unset                               | Policy/runtime key used for snapshots and receipts      |
| `AI_CONTROL_CONNECTOR_INSTANCE_ID`        | host name                           | Stable connector instance identity                      |
| `AI_CONTROL_SPOOL_PATH`                   | `.tokenpilot/litellm-spool.sqlite3` | Durable local SQLite file                               |
| `AI_CONTROL_MAX_SPOOL_BYTES`              | `536870912`                         | Hard spool/rejected archive disk cap                    |
| `AI_CONTROL_BATCH_SIZE`                   | `100`                               | Events per upload                                       |
| `AI_CONTROL_FLUSH_INTERVAL_SECONDS`       | `1`                                 | Idle sender interval                                    |
| `AI_CONTROL_RETRY_BASE_SECONDS`           | `1`                                 | Initial retry ceiling                                   |
| `AI_CONTROL_RETRY_MAX_SECONDS`            | `300`                               | Maximum retry ceiling                                   |
| `AI_CONTROL_HEARTBEAT_INTERVAL_SECONDS`   | `30`                                | Connector health interval                               |
| `AI_CONTROL_POLICY_POLL_INTERVAL_SECONDS` | `30`                                | Runtime policy refresh interval                         |
| `AI_CONTROL_POLICY_LKG_PATH`              | `.tokenpilot/runtime-snapshot.json` | Durable last-known-good routing snapshot                |
| `AI_CONTROL_POLICY_REQUIRED`              | `true`                              | Reject calls until a trusted runtime snapshot is usable |
| `AI_CONTROL_SENDER_ENABLED`               | `true`                              | Disable only for capture-only diagnostics               |

Mount the spool directory on persistent local storage and allow only the LiteLLM process account to
read it. When the ingestion key is absent, callbacks still buffer locally but upload and heartbeat
workers remain stopped. A successfully applied snapshot is atomically stored with its
`application_id` and a one-way fingerprint of the policy key. The Connector rejects a snapshot
from another application or key. If no trusted snapshot is available, the default
`AI_CONTROL_POLICY_REQUIRED=true` blocks the call; set it to `false` only when explicit fail-open
behavior is acceptable.

## Privacy and failure behavior

- The response object, messages, prompt, response, tool arguments, request headers, Provider API
  keys, and LiteLLM user-key data are never serialized.
- Trusted usage identity is read only from the reserved `metadata.cp` object. Field names, types,
  lengths, and content-bearing keys are validated locally. The API derives the application from the
  ingest key; request metadata cannot choose or overwrite it.
- Ordinary metadata such as `member_level`, `end_user_id`, `subject_id`, or
  `quota_dimensions` is ignored and can never become quota context. LiteLLM route tags are retained
  only when they match the reserved `cp:*` tag grammar.
- On an actual LiteLLM fallback, the Connector projects only the previous deployment's
  `model_info.id` into `fallback_from`. It discards the rest of `previous_models`, including raw
  exception strings, messages, parameters, and credentials.
- `turn_off_message_logging: true` is enabled in the example as a second independent privacy layer.
- Rows are deleted only after a `202` per-event `accepted` or `duplicate` result. Conflicts and
  schema failures move transactionally to `spool_rejected`; network, `5xx`, auth, malformed
  responses, and other transient failures use exponential backoff with full jitter.
- A full disk cap emits `SPOOL_CAPACITY_REACHED` and rejects the new local write. Existing
  unacknowledged and rejected rows are never silently evicted.
- Opening a spool after a process crash reclaims incomplete upload leases immediately.
- Batch uploads use `POST /usage-events/batch`. Heartbeats use `POST /connectors/heartbeat` and
  advertise the usage schema, signed-context capability, content-free privacy mode, and durable
  batch support in the heartbeat payload and defense-in-depth headers.

The Connector preserves the LiteLLM model tag and the selected TokenPilot model ID for attribution;
it never rewrites Provider configuration or Provider keys.

## Runtime configuration lifecycle

The policy key can read only its own application's Runtime Snapshot. Each snapshot carries the
application ID, immutable content ETag, application-binding signature, configuration version,
virtual-model routes, blocked users, and quota mode. The Connector verifies all of these before it
changes active routing.

Applying a snapshot is atomic: the Connector first reports `received`, writes and fsyncs the new
last-known-good envelope, swaps the in-memory configuration, and then reports `applied`. Invalid
content or a failed local write reports `rejected` with a privacy-safe reason and leaves the previous
configuration active. A failed `applied` receipt is retried, including after process restart. Pull
failures keep using the unexpired last-known-good configuration, so application and user blocks in
that configuration remain effective while TokenPilot is temporarily unavailable.

## Develop and verify

Regenerate Pydantic models from the repository root with `pnpm generate:contracts`; never edit the
generated module by hand.

```bash
uv sync --project connectors/litellm --locked --all-groups
uv run --project connectors/litellm ruff check connectors/litellm
uv run --project connectors/litellm mypy connectors/litellm/src connectors/litellm/tests connectors/litellm/scripts
uv run --project connectors/litellm pytest connectors/litellm/tests
```

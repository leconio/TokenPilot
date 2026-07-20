# LiteLLM and SDK integration

[中文](integration.zh-CN.md)

TokenPilot observes usage and distributes application-bound runtime configuration. LiteLLM remains
the model gateway and the only place that needs Provider credentials. TokenPilot receives no
prompt, response, tool argument, or Provider key.

## Application keys

Create keys in the target application's **Settings** page. Use separate keys for:

- usage upload and Connector heartbeat;
- runtime snapshot, acknowledgement, and AIU reservation;
- report verification or administration.

The key determines the application. Do not add `application_id` to an event and do not share a key
between applications.

## Install the Connector

Install `connectors/litellm` into the same Python environment as LiteLLM and register
`deploy/litellm/ai_control_callback.py` for success and failure callbacks. The deployment image
already includes both.

```dotenv
AI_CONTROL_URL=https://tokenpilot.example.com
AI_CONTROL_API_KEY=<application-usage-key>
AI_CONTROL_POLICY_API_KEY=<application-runtime-key>
AI_CONTROL_CONNECTOR_INSTANCE_ID=litellm-production-01
AI_CONTROL_SPOOL_PATH=/var/lib/tokenpilot/litellm-spool.sqlite3
AI_CONTROL_POLICY_LKG_PATH=/var/lib/tokenpilot/runtime-configuration.json
AI_CONTROL_POLICY_REQUIRED=true
AI_CONTROL_BATCH_SIZE=100
AI_CONTROL_FLUSH_INTERVAL_SECONDS=1
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

The shared callback activates the request hook for routing and quota decisions. The explicit
success and failure callbacks record every real Provider attempt, including a successful fallback.

Persist the spool directory. If TokenPilot is temporarily unavailable, the Connector writes to
SQLite WAL and retries with bounded backoff. Runtime configuration is applied atomically; invalid
updates are rejected and the last successful file remains usable.
The saved file is bound to the snapshot's `application_id` and the runtime-key fingerprint. On
restart the Connector verifies that binding and re-sends its `applied` receipt. With the default
`AI_CONTROL_POLICY_REQUIRED=true`, a call is rejected when neither a valid current snapshot nor an
unexpired last-successful snapshot is available.

## Report user and custom fields

Every model call must provide `user_id`; `display_user` is recommended. The first accepted report
automatically creates the user in that application and later reports may update the display name.

Place TokenPilot context under the reserved `cp` metadata object:

```python
response = await litellm.acompletion(
    model="customer-support",
    messages=[{"role": "user", "content": prompt}],
    metadata={
        "cp": {
            "user_id": "customer-42",
            "display_user": "Ada",
            "app_version": "2026.07.18",
            "event_properties": {
                "next_action": "review",
                "voice_enabled": False,
            },
            "user_properties": {
                "voice_type": "standard",
                "parse_context": "support",
            },
        }
    },
)
```

Define these fields in the application's **Fields** page before reporting. Supported analytical
types are text, number, boolean, time, enum, and text list. The Connector validates limits and type,
removes content-bearing keys, and uploads only normalized metadata and usage counters.

## Virtual models and routing

Application code calls a virtual model such as `customer-support`. The published runtime snapshot
contains its real LiteLLM candidates, ordered fallback, schedules, user or user-group conditions,
temporary switches, blocked users, and quota behavior. `GET /runtime/snapshot` supports `ETag` and
returns `304` when unchanged.

After applying a configuration, the Connector posts an acknowledgement to
`/runtime/configuration-acknowledgements`. The Web release page shows active only when the current
application's Connector confirms the exact version.

## Strict AIU quota

When strict quota is enabled, the trusted runtime uses the application runtime key to:

1. create `/runtime/users/aiu/reservations` with `user_id`, operation, virtual model, and estimated
   micro-AIU;
2. call LiteLLM only when `allowed` is true;
3. settle the reservation with actual AIU after success;
4. release it after cancellation or failure.

The operation identifier makes retries idempotent. The server binds the signed token to the
application and user. Calls without `user_id` are rejected instead of bypassing usage or quota.

## SDKs and native example

The Node and Python SDKs provide typed context construction, snapshot caching, routing, and runtime
helpers. See `sdks/node` and `sdks/python`. The complete Mac-native LiteLLM exercise is in
[`examples/litellm-local`](../examples/litellm-local/README.md); dependency and Provider access can
use `HTTP_PROXY` and `HTTPS_PROXY` without installing a local container runtime.

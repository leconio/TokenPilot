# TokenPilot Python SDK

`tokenpilot-sdk` lets a Python 3.12 server application call a stable virtual model while
TokenPilot chooses the real model and connection. It supports LiteLLM, OpenAI-compatible services,
Anthropic, fallback, synchronous and asynchronous streaming, user AIU limits, hot configuration,
and durable usage reporting.

Prompts and responses go only to the selected model service. TokenPilot receives model identity,
user context, timing, outcome, and usage counters—not messages, tool arguments, or Provider
credentials.

## Minimal call

Use the application key shown once during Setup. It needs `runtime:read`, `runtime:write`,
`runtime:ack`, and `usage:write`.

```python
import os

from ai_control_sdk import AiRuntimeClient, AiRuntimeContext, ai_context

pilot = AiRuntimeClient(
    control_plane_url=os.environ["TOKENPILOT_URL"],
    api_key=os.environ["TOKENPILOT_APPLICATION_KEY"],
    # Keys are looked up by each connection's credential reference.
    credentials={"OPENAI_API_KEY": os.environ["OPENAI_API_KEY"]},
)
pilot.start()  # Loads now and refreshes future requests in the background.

with ai_context(
    AiRuntimeContext(
        user_id="customer-42",
        display_user="Ada",
        application_version="python-2.8.0",
        call_source="receipt_parse",
        event_properties={"voice_enabled": False, "next_action": "confirm"},
        user_properties={"member_level": "pro"},
    )
):
    result = pilot.chat(
        model="customer-support",  # Virtual model, not a Provider model name.
        messages=[{"role": "user", "content": "The request content stays here."}],
    )

print(result.target.request_model, result.attempts)
pilot.flush_usage()
pilot.close()
```

Use `chat_stream()` for synchronous iteration. `AsyncAiRuntimeClient` provides `await chat()` and
an asynchronous `chat_stream()`. Cancelling the task or closing a stream records cancellation and
does not continue to another model after output has already been emitted. In hard-limit mode, pass
a conservative `estimated_aiu_micros`; final rated AIU is reconciled by the processing pipeline.

## Existing Provider clients

Register an adapter by connection ID when an application already has an official SDK client,
custom proxy, connection pool, or retry policy. The adapter receives the selected real model and
returns normalized usage. A connection adapter takes precedence over a driver-wide adapter.

Use `record_usage()` for a service without a full adapter. It still requires an active user
context, a published virtual model, a valid candidate real-model ID, and caller-generated
idempotency IDs. It cannot bypass application isolation or report model content.

## Reliability and privacy

- `start()` uses ETag refresh and keeps a signed last-known-good file.
- Usage first enters a bounded SQLite spool and is safely replayed after an outage.
- `user_id` is required; `display_user` is recommended.
- Define custom fields in the Web console before sending them. Reserved content and credential keys
  are rejected locally.
- Credentials come from the `credentials` map, a `credential_resolver`, or the process environment.
  Published configuration contains references only.

## Verify

```bash
UV_CACHE_DIR=/tmp/tokenpilot-uv-cache uv run --project sdks/python ruff check sdks/python
UV_CACHE_DIR=/tmp/tokenpilot-uv-cache uv run --project sdks/python mypy sdks/python/src
UV_CACHE_DIR=/tmp/tokenpilot-uv-cache uv run --project sdks/python pytest \
  --rootdir sdks/python sdks/python/tests --cov=ai_control_sdk
```

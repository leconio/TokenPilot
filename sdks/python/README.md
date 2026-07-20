# Python runtime SDK

`tokenpilot-sdk` is the Python 3.12 trusted server helper for one TokenPilot application. Its
runtime key binds requests to that application. The SDK keeps an atomic last-known-good routing
configuration, selects real LiteLLM models for virtual models, attaches content-free user and event
metadata, and supports synchronous or asynchronous strict AIU reservations.

```python
from ai_control_sdk import AiRuntimeClient, AiRuntimeContext, ai_context
from ai_control_sdk import apply_ai_context_to_openai_request

runtime = AiRuntimeClient(
    control_plane_url="http://tokenpilot-api:4000",
    api_key="...application runtime key...",
    sdk_version="0.2.0",
)
runtime.refresh()

with ai_context(
    AiRuntimeContext(
        user_id="customer-1",
        display_user="Ada",
        application_version="python-2.8.0",
        session_id="session-42",
        call_source="receipt_parse",
        event_properties={"voice_enabled": True, "next_action": "confirm"},
        user_properties={"member_level": "pro"},
    )
):
    body, options = apply_ai_context_to_openai_request(
        runtime,
        {"model": "receipt-reader", "messages": messages},
    )
```

`user_id` is required. Property keys and values are checked locally; content-bearing or credential
fields such as `prompt`, `response`, `messages`, `authorization`, and `api_key` are rejected. The
request helper removes caller-supplied TokenPilot metadata and reserved LiteLLM tags before adding
its own envelope. It never copies prompt or response content into that envelope.

The runtime key needs `runtime:read`, `runtime:write`, and `runtime:ack`. A failed refresh keeps the
last successfully applied configuration.

```bash
uv run --project sdks/python pytest
uv run --project sdks/python ruff check sdks/python
uv run --project sdks/python mypy sdks/python
```

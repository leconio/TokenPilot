from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest
from runtime_testkit import (
    API_KEY,
    NOW,
    SNAPSHOT,
    accepted_usage_response,
    hard_limit_snapshot,
    runtime_client,
)

from ai_control_sdk import (
    AiControlSdkError,
    AiRuntimeClient,
    AiRuntimeContext,
    AsyncAiRuntimeClient,
    ai_context,
    async_ai_context,
)
from ai_control_sdk.runtime.client_helpers import (
    normalize_control_plane_url,
    resolve_async_connection_credential,
    resolve_sync_credential,
)
from ai_control_sdk.runtime.contracts import RuntimeCallConnection, RuntimeRouteTarget
from ai_control_sdk.runtime.provider_transport import (
    merge_usage,
    provider_failure,
    provider_request,
    sse_value,
    stream_request,
    stream_usage,
    usage,
)


def connection(
    *,
    driver: str = "openai_compatible",
    base_url: str | None = "https://models.test/v1",
    credential_ref: str | None = "MODEL_KEY",
) -> RuntimeCallConnection:
    return RuntimeCallConnection.model_validate(
        {
            "id": "connection-test",
            "name": "Test connection",
            "driver": driver,
            "base_url": base_url,
            "credential_ref": credential_ref,
            "timeout_ms": 1_000,
            "max_retries": 0,
        }
    )


def target() -> RuntimeRouteTarget:
    return RuntimeRouteTarget.model_validate(
        {
            "model_id": "model-test",
            "connection_id": "connection-test",
            "request_model": "provider-model",
            "provider": "provider",
            "task_type": "chat",
            "capabilities": ["streaming", "tools", "structured_output"],
            "route_tag": "cp:test:default",
            "fallback_order": 0,
            "weight": 1,
        }
    )


def test_provider_transport_maps_requests_usage_streams_and_failures() -> None:
    messages = [
        {"role": "system", "content": "Be concise"},
        {"role": "user", "content": "Hello"},
    ]
    anthropic = connection(driver="anthropic", base_url=None)
    url, headers, body = provider_request(
        anthropic,
        "claude-test",
        messages,
        "secret",
        max_tokens=None,
        temperature=0.2,
        tools=[{"name": "lookup"}],
        response_format=None,
    )
    assert url == "https://api.anthropic.com/v1/messages"
    assert headers["x-api-key"] == "secret"
    assert body["system"] == ["Be concise"]
    assert body["temperature"] == 0.2
    assert body["tools"] == [{"name": "lookup"}]

    openai = connection()
    url, headers, body = stream_request(
        openai,
        target(),
        messages,
        "secret",
        max_tokens=12,
        temperature=0.1,
        tools=[{"type": "function"}],
        response_format={"type": "json_object"},
    )
    assert url.endswith("/chat/completions")
    assert headers["authorization"] == "Bearer secret"
    assert body["model"] == "provider-model"
    assert body["stream_options"] == {"include_usage": True}
    assert body["response_format"] == {"type": "json_object"}
    assert body["temperature"] == 0.1
    assert body["tools"] == [{"type": "function"}]

    assert usage(
        {
            "usage": {
                "prompt_tokens": 10,
                "prompt_tokens_details": {"cached_tokens": 4},
                "completion_tokens": 3,
                "completion_tokens_details": {"reasoning_tokens": 2},
            }
        },
        "openai_compatible",
    ) == {
        "uncached_input_tokens": "6",
        "cache_read_input_tokens": "4",
        "output_tokens": "3",
        "reasoning_output_tokens": "2",
        "request_count": "1",
    }
    assert stream_usage({"usage": {"prompt_tokens": 2}}, "openai_compatible") is not None
    assert stream_usage({"choices": []}, "openai_compatible") is None
    assert stream_usage("not-an-event", "openai_compatible") is None
    assert stream_usage({"message": {"usage": {"input_tokens": 2}}}, "anthropic") is not None
    measured = {"request_count": "1", "output_tokens": "2"}
    merge_usage(measured, {"output_tokens": "5", "custom": "value"})
    merge_usage(measured, None)
    assert measured == {"request_count": "1", "output_tokens": "5", "custom": "value"}

    assert sse_value("event: message", 200) is None
    assert sse_value("data: [DONE]", 200) is None
    assert sse_value('data: {"ok":true}', 200) == {"ok": True}
    with pytest.raises(Exception, match="invalid streaming data"):
        sse_value("data: not-json", 200)
    timeout = provider_failure(httpx.ReadTimeout("late"))
    assert timeout.kind == "timeout" and timeout.retryable
    response = httpx.Response(429, request=httpx.Request("POST", "https://models.test"))
    limited = provider_failure(
        httpx.HTTPStatusError("limited", request=response.request, response=response)
    )
    assert limited.status == 429 and limited.retryable
    assert provider_failure(OSError("offline")).retryable


def test_client_configuration_and_credentials_cover_map_resolver_environment_and_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configured = connection()
    no_reference = connection(credential_ref=None)
    assert normalize_control_plane_url("https://control.test/") == "https://control.test"
    with pytest.raises(AiControlSdkError, match="absolute HTTP"):
        normalize_control_plane_url("control.test")
    assert resolve_sync_credential(no_reference, {}, None) == ""
    assert resolve_sync_credential(configured, {"MODEL_KEY": "mapped"}, None) == "mapped"
    assert (
        resolve_sync_credential(configured, {}, lambda _key, _connection: "resolved") == "resolved"
    )
    monkeypatch.setenv("MODEL_KEY", "environment")
    assert resolve_sync_credential(configured, {}, None) == "environment"
    monkeypatch.delenv("MODEL_KEY")
    with pytest.raises(AiControlSdkError, match="MODEL_KEY"):
        resolve_sync_credential(configured, {}, None)

    async def run() -> None:
        async def resolver(_key: str, _connection: RuntimeCallConnection) -> str:
            return "async-resolved"

        assert await resolve_async_connection_credential(no_reference, {}, None) == ""
        assert (
            await resolve_async_connection_credential(configured, {}, resolver) == "async-resolved"
        )

    asyncio.run(run())


def test_chat_rejects_missing_runtime_empty_messages_and_missing_hard_limit_estimate(
    tmp_path: Path,
) -> None:
    runtime = AiRuntimeClient(
        control_plane_url="http://control.test",
        api_key=API_KEY,
        lkg_path=tmp_path / "empty.json",
        refresh_interval_seconds=0,
    )
    with ai_context(AiRuntimeContext(user_id="edge-user")):
        with pytest.raises(ValueError, match="cannot be empty"):
            runtime.chat(model="text.fast", messages=[])
        with pytest.raises(AiControlSdkError, match="No Runtime Snapshot"):
            runtime.chat(model="text.fast", messages=[{"role": "user", "content": "hello"}])
    runtime.close()

    def control(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/runtime/snapshot":
            return httpx.Response(200, json=hard_limit_snapshot())
        if request.url.path == "/runtime/configuration-acknowledgements":
            return httpx.Response(202)
        raise AssertionError(request.url.path)

    hard = AiRuntimeClient(
        control_plane_url="http://control.test",
        api_key=API_KEY,
        lkg_path=tmp_path / "hard.json",
        http_client=httpx.Client(transport=httpx.MockTransport(control)),
        now=lambda: NOW,
    )
    hard.refresh()
    with (
        ai_context(AiRuntimeContext(user_id="edge-user")),
        pytest.raises(AiControlSdkError, match="estimated_aiu_micros"),
    ):
        hard.chat(model="text.fast", messages=[{"role": "user", "content": "hello"}])
    hard.close()


def test_chat_rejects_image_input_before_calling_an_incompatible_target(tmp_path: Path) -> None:
    runtime = runtime_client(tmp_path / "capability.json", lambda _request: httpx.Response(404))
    runtime.refresh()
    with (
        ai_context(AiRuntimeContext(user_id="image-user")),
        pytest.raises(AiControlSdkError) as raised,
    ):
        runtime.chat(
            model="text.fast",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": "https://image.test/a.png"}}
                    ],
                }
            ],
        )
    assert raised.value.code == "SDK_MODEL_CAPABILITY_UNAVAILABLE"
    runtime.close()


def test_async_chat_reports_invalid_provider_response_without_exposing_credentials(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        errors: list[Exception] = []

        def control(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/runtime/snapshot":
                return httpx.Response(200, json=SNAPSHOT)
            if request.url.path == "/runtime/configuration-acknowledgements":
                return httpx.Response(202)
            if request.url.path == "/usage-events/batch":
                return accepted_usage_response(request)
            raise AssertionError(request.url.path)

        runtime = AsyncAiRuntimeClient(
            control_plane_url="http://control.test",
            api_key=API_KEY,
            lkg_path=tmp_path / "async-edge.json",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(control)),
            provider_http_client=httpx.AsyncClient(
                transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=[]))
            ),
            credentials={"OPENAI_API_KEY": "secret"},
            now=lambda: NOW,
            on_error=errors.append,
        )
        await runtime.refresh()
        async with async_ai_context(AiRuntimeContext(user_id="async-edge-user")):
            with pytest.raises(AiControlSdkError, match="invalid response") as raised:
                await runtime.chat(
                    model="text.fast", messages=[{"role": "user", "content": "hello"}]
                )
        assert raised.value.code == "SDK_MODEL_REQUEST_FAILED"
        assert all("secret" not in str(error) for error in errors)
        await runtime.close()

        provider_calls = 0

        def unexpected_provider(_request: httpx.Request) -> httpx.Response:
            nonlocal provider_calls
            provider_calls += 1
            return httpx.Response(500)

        missing = AsyncAiRuntimeClient(
            control_plane_url="http://control.test",
            api_key=API_KEY,
            lkg_path=tmp_path / "async-missing-credential.json",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(control)),
            provider_http_client=httpx.AsyncClient(
                transport=httpx.MockTransport(unexpected_provider)
            ),
            now=lambda: NOW,
            on_error=errors.append,
        )
        await missing.refresh()
        async with async_ai_context(AiRuntimeContext(user_id="missing-credential-user")):
            with pytest.raises(AiControlSdkError) as missing_error:
                await missing.chat(
                    model="text.fast", messages=[{"role": "user", "content": "hello"}]
                )
        assert missing_error.value.code == "SDK_MODEL_REQUEST_FAILED"
        assert provider_calls == 0
        await missing.close()

    asyncio.run(run())

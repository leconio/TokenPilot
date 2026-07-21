from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any

import httpx
import pytest
from runtime_testkit import (
    API_KEY,
    NOW,
    SNAPSHOT,
    accepted_usage_response,
    signed_snapshot,
)

from ai_control_sdk import (
    AiControlSdkError,
    AiRuntimeClient,
    AiRuntimeContext,
    AsyncAiRuntimeClient,
    AsyncProviderChatStreamResponse,
    ProviderChatRequest,
    ProviderChatResponse,
    ProviderChatStreamResponse,
    ProviderStreamPart,
    SourceCost,
    ai_context,
    async_ai_context,
)


def test_closing_sync_stream_records_cancellation_without_fallback(tmp_path: Path) -> None:
    batches: list[dict[str, Any]] = []
    calls = 0

    class StreamAdapter:
        requires_credential = False

        def chat(self, _request: ProviderChatRequest) -> ProviderChatResponse:
            return ProviderChatResponse(response={})

        def stream(self, _request: ProviderChatRequest) -> ProviderChatStreamResponse:
            def parts() -> Any:
                nonlocal calls
                calls += 1
                yield ProviderStreamPart(value={"delta": "partial"})
                while True:
                    yield ProviderStreamPart(value={"delta": "unused"})

            return ProviderChatStreamResponse(stream=parts())

    def control(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/runtime/snapshot":
            return httpx.Response(200, json=SNAPSHOT)
        if request.url.path == "/runtime/configuration-acknowledgements":
            return httpx.Response(202)
        if request.url.path == "/usage-events/batch":
            batches.append(json.loads(request.content))
            return accepted_usage_response(request)
        raise AssertionError(request.url.path)

    runtime = AiRuntimeClient(
        control_plane_url="http://control.test",
        api_key=API_KEY,
        lkg_path=tmp_path / "cancel-stream.json",
        http_client=httpx.Client(transport=httpx.MockTransport(control)),
        now=lambda: NOW,
    ).register_provider_adapter("openai_compatible", StreamAdapter())
    runtime.refresh()
    with ai_context(AiRuntimeContext(user_id="cancel-user")):
        stream = runtime.chat_stream(
            model="text.fast", messages=[{"role": "user", "content": "hello"}]
        )
        assert next(stream) == {"delta": "partial"}
        stream.close()
    assert calls == 1
    assert len(batches[0]["events"]) == 1
    assert batches[0]["events"][0]["result"]["status"] == "cancelled"
    runtime.close()


def test_timeout_retries_are_bounded_and_every_attempt_is_reported(tmp_path: Path) -> None:
    batches: list[dict[str, Any]] = []
    calls = 0

    def control(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/runtime/snapshot":
            return httpx.Response(200, json=SNAPSHOT)
        if request.url.path == "/runtime/configuration-acknowledgements":
            return httpx.Response(202)
        if request.url.path == "/usage-events/batch":
            batches.append(json.loads(request.content))
            return accepted_usage_response(request)
        raise AssertionError(request.url.path)

    def timeout(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("timed out", request=request)

    runtime = AiRuntimeClient(
        control_plane_url="http://control.test",
        api_key=API_KEY,
        lkg_path=tmp_path / "timeout.json",
        http_client=httpx.Client(transport=httpx.MockTransport(control)),
        provider_http_client=httpx.Client(transport=httpx.MockTransport(timeout)),
        credentials={
            "OPENAI_API_KEY": "openai-secret",
            "ANTHROPIC_API_KEY": "anthropic-secret",
        },
        now=lambda: NOW,
    )
    runtime.refresh()
    with (
        ai_context(AiRuntimeContext(user_id="timeout-user")),
        pytest.raises(AiControlSdkError, match="timed out"),
    ):
        runtime.chat(model="text.fast", messages=[{"role": "user", "content": "hello"}])
    assert calls == 3
    events = batches[0]["events"]
    assert [event["result"]["status"] for event in events] == ["timeout"] * 3
    assert events[-1]["request"]["is_final_attempt"] is True
    runtime.close()


def test_background_start_applies_new_route_without_restart(tmp_path: Path) -> None:
    changed = json.loads(json.dumps(SNAPSHOT))
    changed["version"] = "runtime-v43"
    changed["routing"]["text.fast"]["configuration_version"] = 82
    targets = list(reversed(changed["routing"]["text.fast"]["default"]["targets"]))
    for index, target in enumerate(targets):
        target["fallback_order"] = index
    changed["routing"]["text.fast"]["default"]["targets"] = targets
    snapshots = [SNAPSHOT, signed_snapshot(changed)]
    reads = 0

    def control(request: httpx.Request) -> httpx.Response:
        nonlocal reads
        if request.url.path == "/runtime/snapshot":
            value = snapshots[min(reads, len(snapshots) - 1)]
            reads += 1
            return httpx.Response(200, json=value)
        if request.url.path == "/runtime/configuration-acknowledgements":
            return httpx.Response(202)
        raise AssertionError(request.url.path)

    runtime = AiRuntimeClient(
        control_plane_url="http://control.test",
        api_key=API_KEY,
        lkg_path=tmp_path / "hot.json",
        http_client=httpx.Client(transport=httpx.MockTransport(control)),
        refresh_interval_seconds=1,
        now=lambda: NOW,
    )
    runtime.start()
    assert runtime.select_route("text.fast").primary.model_id == "model-primary"
    time.sleep(1.1)
    assert runtime.select_route("text.fast").primary.model_id == "model-fallback"
    runtime.close()


def test_async_stream_and_request_cancellation_have_matching_semantics(tmp_path: Path) -> None:
    async def run() -> None:
        batches: list[dict[str, Any]] = []

        class AsyncAdapter:
            requires_credential = False

            def __init__(self) -> None:
                self.stream_calls = 0

            async def chat(self, _request: ProviderChatRequest) -> ProviderChatResponse:
                await asyncio.Future()
                raise AssertionError("unreachable")

            async def stream(
                self, _request: ProviderChatRequest
            ) -> AsyncProviderChatStreamResponse:
                self.stream_calls += 1

                async def parts() -> Any:
                    yield ProviderStreamPart(
                        value={"delta": "ok"},
                        usage={"uncached_input_tokens": "1", "output_tokens": "1"},
                        source_cost=SourceCost(
                            amount="0.006",
                            currency="USD",
                            is_estimated=True,
                        ),
                    )
                    if self.stream_calls > 1:
                        await asyncio.Future()

                return AsyncProviderChatStreamResponse(stream=parts())

        def control(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/runtime/snapshot":
                return httpx.Response(200, json=SNAPSHOT)
            if request.url.path == "/runtime/configuration-acknowledgements":
                return httpx.Response(202)
            if request.url.path == "/usage-events/batch":
                batches.append(json.loads(request.content))
                return accepted_usage_response(request)
            raise AssertionError(request.url.path)

        adapter = AsyncAdapter()
        runtime = AsyncAiRuntimeClient(
            control_plane_url="http://control.test",
            api_key=API_KEY,
            lkg_path=tmp_path / "async-stream.json",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(control)),
            now=lambda: NOW,
        ).register_provider_adapter("openai_compatible", adapter)
        await runtime.refresh()
        async with async_ai_context(AiRuntimeContext(user_id="async-stream-user")):
            values = [
                value
                async for value in runtime.chat_stream(
                    model="text.fast", messages=[{"role": "user", "content": "hello"}]
                )
            ]
        assert values == [{"delta": "ok"}]
        assert batches[-1]["events"][0]["result"]["status"] == "success"
        assert batches[-1]["events"][0]["source_cost"] == {
            "amount": "0.006",
            "currency": "USD",
            "is_estimated": True,
        }

        async with async_ai_context(AiRuntimeContext(user_id="async-stream-cancel-user")):
            stream = runtime.chat_stream(
                model="text.fast", messages=[{"role": "user", "content": "cancel stream"}]
            )
            assert await anext(stream) == {"delta": "ok"}
            await stream.aclose()
        assert batches[-1]["events"][0]["result"]["status"] == "cancelled"

        async with async_ai_context(AiRuntimeContext(user_id="async-cancel-user")):
            task = asyncio.create_task(
                runtime.chat(model="text.fast", messages=[{"role": "user", "content": "cancel"}])
            )
            await asyncio.sleep(0)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert batches[-1]["events"][0]["result"]["status"] == "cancelled"
        await runtime.close()

    asyncio.run(run())


def test_stream_falls_back_from_rate_limited_openai_to_anthropic(tmp_path: Path) -> None:
    batches: list[dict[str, Any]] = []
    calls = 0

    def control(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/runtime/snapshot":
            return httpx.Response(200, json=SNAPSHOT)
        if request.url.path == "/runtime/configuration-acknowledgements":
            return httpx.Response(202)
        if request.url.path == "/usage-events/batch":
            batches.append(json.loads(request.content))
            return accepted_usage_response(request)
        raise AssertionError(request.url.path)

    def provider(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if request.url.host == "api.openai.test":
            return httpx.Response(429, json={"error": "rate limited"})
        assert request.headers["x-api-key"] == "anthropic-secret"
        assert json.loads(request.content)["stream"] is True
        content = "".join(
            [
                "data: "
                + json.dumps(
                    {
                        "type": "message_start",
                        "message": {
                            "usage": {
                                "input_tokens": 12,
                                "cache_creation_input_tokens": 3,
                                "cache_read_input_tokens": 4,
                            }
                        },
                    }
                )
                + "\n\n",
                'data: {"type":"content_block_delta","delta":{"text":"ok"}}\n\n',
                'data: {"type":"message_delta","usage":{"output_tokens":5}}\n\n',
            ]
        )
        return httpx.Response(200, content=content, headers={"content-type": "text/event-stream"})

    runtime = AiRuntimeClient(
        control_plane_url="http://control.test",
        api_key=API_KEY,
        lkg_path=tmp_path / "stream-fallback.json",
        http_client=httpx.Client(transport=httpx.MockTransport(control)),
        provider_http_client=httpx.Client(transport=httpx.MockTransport(provider)),
        credentials={
            "OPENAI_API_KEY": "openai-secret",
            "ANTHROPIC_API_KEY": "anthropic-secret",
        },
        now=lambda: NOW,
    )
    runtime.refresh()
    with ai_context(AiRuntimeContext(user_id="stream-fallback-user")):
        chunks = list(
            runtime.chat_stream(model="text.fast", messages=[{"role": "user", "content": "hello"}])
        )
    assert len(chunks) == 3
    assert calls == 3
    events = batches[0]["events"]
    assert [event["result"]["status"] for event in events] == [
        "failure",
        "failure",
        "success",
    ]
    assert events[-1]["usage"] == {
        "request_count": "1",
        "uncached_input_tokens": "12",
        "cache_read_input_tokens": "4",
        "cache_write_input_tokens": "3",
        "output_tokens": "5",
    }
    runtime.close()

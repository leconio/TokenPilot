from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
from runtime_testkit import (
    API_KEY,
    NOW,
    SNAPSHOT,
    accepted_usage_response,
)

from ai_control_sdk import (
    AiRuntimeClient,
    AiRuntimeContext,
    AsyncAiRuntimeClient,
    ProviderChatRequest,
    ProviderChatResponse,
    ProviderChatStreamResponse,
    SourceCost,
    ai_context,
    async_ai_context,
)


def test_chat_falls_back_across_connections_and_reports_each_attempt(tmp_path: Path) -> None:
    batches: list[dict[str, Any]] = []
    provider_paths: list[str] = []

    def control_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/runtime/snapshot":
            return httpx.Response(200, json=SNAPSHOT)
        if request.url.path == "/runtime/configuration-acknowledgements":
            return httpx.Response(202)
        if request.url.path == "/usage-events/batch":
            batches.append(json.loads(request.content))
            return httpx.Response(202)
        raise AssertionError(request.url.path)

    def provider_handler(request: httpx.Request) -> httpx.Response:
        provider_paths.append(request.url.path)
        if request.url.host == "api.openai.test":
            return httpx.Response(503, json={"error": "busy"})
        assert request.headers["x-api-key"] == "anthropic-secret"
        assert json.loads(request.content)["model"] == "litellm-fallback"
        return httpx.Response(
            200,
            json={
                "content": [{"type": "text", "text": "fallback worked"}],
                "usage": {"input_tokens": 12, "output_tokens": 5},
            },
        )

    runtime = AiRuntimeClient(
        control_plane_url="http://control.test",
        api_key=API_KEY,
        lkg_path=tmp_path / "chat.json",
        http_client=httpx.Client(transport=httpx.MockTransport(control_handler)),
        provider_http_client=httpx.Client(transport=httpx.MockTransport(provider_handler)),
        credentials={
            "OPENAI_API_KEY": "openai-secret",
            "ANTHROPIC_API_KEY": "anthropic-secret",
        },
        now=lambda: NOW,
    )
    runtime.refresh()
    with ai_context(
        AiRuntimeContext(
            user_id="user-chat",
            display_user="Chat User",
            event_properties={"next_action": "answer"},
            analytics_dimensions={"client": "python"},
        )
    ):
        result = runtime.chat(model="text.fast", messages=[{"role": "user", "content": "hello"}])

    assert result.connection.id == "connection-fallback"
    assert [attempt.status for attempt in result.attempts] == ["failure", "failure", "success"]
    assert provider_paths == ["/v1/chat/completions", "/v1/chat/completions", "/v1/messages"]
    events = batches[0]["events"]
    assert [event["request"]["attempt_index"] for event in events] == [0, 1, 2]
    assert [event["request"]["is_final_attempt"] for event in events] == [False, False, True]
    assert events[-1]["model"]["connection_driver"] == "anthropic"
    assert events[-1]["usage"]["output_tokens"] == "5"
    assert events[-1]["event_properties"] == {"next_action": "answer"}
    runtime.close()


def test_async_chat_uses_openai_compatible_connection(tmp_path: Path) -> None:
    async def run() -> None:
        batches: list[dict[str, Any]] = []

        def control_handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/runtime/snapshot":
                return httpx.Response(200, json=SNAPSHOT)
            if request.url.path == "/runtime/configuration-acknowledgements":
                return httpx.Response(202)
            if request.url.path == "/usage-events/batch":
                batches.append(json.loads(request.content))
                return httpx.Response(202)
            raise AssertionError(request.url.path)

        def provider_handler(request: httpx.Request) -> httpx.Response:
            assert request.headers["authorization"] == "Bearer openai-secret"
            return httpx.Response(
                200,
                json={
                    "choices": [{"message": {"role": "assistant", "content": "ok"}}],
                    "usage": {
                        "prompt_tokens": 10,
                        "prompt_tokens_details": {"cached_tokens": 4},
                        "completion_tokens": 3,
                    },
                },
            )

        runtime = AsyncAiRuntimeClient(
            control_plane_url="http://control.test",
            api_key=API_KEY,
            lkg_path=tmp_path / "async-chat.json",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(control_handler)),
            provider_http_client=httpx.AsyncClient(transport=httpx.MockTransport(provider_handler)),
            credentials={"OPENAI_API_KEY": "openai-secret"},
            now=lambda: NOW,
        )
        await runtime.refresh()
        async with async_ai_context(AiRuntimeContext(user_id="user-async-chat")):
            result = await runtime.chat(
                model="text.fast", messages=[{"role": "user", "content": "hello"}]
            )
        assert result.connection.id == "connection-primary"
        assert batches[0]["events"][0]["usage"]["uncached_input_tokens"] == "6"
        assert batches[0]["events"][0]["usage"]["cache_read_input_tokens"] == "4"
        await runtime.close()

    asyncio.run(run())


def test_chat_usage_is_replayed_after_process_restart(tmp_path: Path) -> None:
    spool_path = tmp_path / "usage-spool.sqlite3"
    first_batches = 0

    def offline_control(request: httpx.Request) -> httpx.Response:
        nonlocal first_batches
        if request.url.path == "/runtime/snapshot":
            return httpx.Response(200, json=SNAPSHOT)
        if request.url.path == "/runtime/configuration-acknowledgements":
            return httpx.Response(202)
        if request.url.path == "/usage-events/batch":
            first_batches += 1
            raise httpx.ConnectError("temporarily offline", request=request)
        raise AssertionError(request.url.path)

    offline = AiRuntimeClient(
        control_plane_url="http://control.test",
        api_key=API_KEY,
        lkg_path=tmp_path / "runtime.json",
        usage_spool_path=spool_path,
        http_client=httpx.Client(transport=httpx.MockTransport(offline_control)),
        provider_http_client=httpx.Client(
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(
                    200,
                    json={
                        "choices": [{"message": {"role": "assistant", "content": "ok"}}],
                        "usage": {"prompt_tokens": 8, "completion_tokens": 2},
                    },
                )
            )
        ),
        credentials={"OPENAI_API_KEY": "openai-secret"},
        now=lambda: NOW,
    )
    offline.refresh()
    with ai_context(AiRuntimeContext(user_id="durable-user")):
        offline.chat(model="text.fast", messages=[{"role": "user", "content": "hello"}])
    assert first_batches == 1
    offline.close()

    replayed = 0

    def recovered_control(request: httpx.Request) -> httpx.Response:
        nonlocal replayed
        if request.url.path == "/runtime/snapshot":
            return httpx.Response(200, json=SNAPSHOT)
        if request.url.path == "/runtime/configuration-acknowledgements":
            return httpx.Response(202)
        if request.url.path == "/usage-events/batch":
            batch = json.loads(request.content)
            replayed += len(batch["events"])
            return httpx.Response(
                202,
                json={
                    "schema_version": "2.0",
                    "batch_id": batch["batch_id"],
                    "received_at": NOW.isoformat().replace("+00:00", "Z"),
                    "accepted": len(batch["events"]),
                    "duplicates": 0,
                    "conflicts": 0,
                    "rejected": 0,
                    "results": [
                        {
                            "index": index,
                            "event_id": event["event_id"],
                            "status": "accepted",
                            "code": None,
                            "message": None,
                        }
                        for index, event in enumerate(batch["events"])
                    ],
                },
            )
        raise AssertionError(request.url.path)

    recovered = AiRuntimeClient(
        control_plane_url="http://control.test",
        api_key=API_KEY,
        lkg_path=tmp_path / "runtime.json",
        usage_spool_path=spool_path,
        http_client=httpx.Client(transport=httpx.MockTransport(recovered_control)),
        now=lambda: NOW,
    )
    recovered.refresh()
    assert replayed == 1
    assert recovered.flush_usage() == 0
    recovered.close()


def test_registered_provider_adapter_reuses_an_existing_client(tmp_path: Path) -> None:
    batches: list[dict[str, Any]] = []

    class ExistingClientAdapter:
        requires_credential = False

        def chat(self, request: ProviderChatRequest) -> ProviderChatResponse:
            assert request.target.request_model == "litellm-primary"
            assert request.credential == ""
            return ProviderChatResponse(
                response={"choices": [{"message": {"content": "existing client"}}]},
                http_status=201,
                usage={"uncached_input_tokens": "3", "output_tokens": "2"},
                source_cost=SourceCost(amount="0.0042", currency="USD"),
            )

        def stream(self, _request: ProviderChatRequest) -> ProviderChatStreamResponse:
            return ProviderChatStreamResponse(stream=())

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
        lkg_path=tmp_path / "adapter.json",
        http_client=httpx.Client(transport=httpx.MockTransport(control)),
        now=lambda: NOW,
    ).register_connection_adapter("connection-primary", ExistingClientAdapter())
    runtime.refresh()
    with ai_context(AiRuntimeContext(user_id="adapter-user")):
        result = runtime.chat(model="text.fast", messages=[{"role": "user", "content": "hi"}])
    assert result.response["choices"][0]["message"]["content"] == "existing client"
    assert result.attempts[0].http_status == 201
    assert batches[0]["events"][0]["usage"]["output_tokens"] == "2"
    assert batches[0]["events"][0]["source_cost"] == {
        "amount": "0.0042",
        "currency": "USD",
        "is_estimated": False,
    }
    runtime.close()


def test_sync_stream_collects_usage_and_reports_only_after_completion(tmp_path: Path) -> None:
    batches: list[dict[str, Any]] = []
    provider_bodies: list[dict[str, Any]] = []

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
        provider_bodies.append(json.loads(request.content))
        content = "".join(
            [
                'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
                "data: "
                + json.dumps(
                    {
                        "choices": [],
                        "usage": {
                            "prompt_tokens": 9,
                            "prompt_tokens_details": {"cached_tokens": 4},
                            "completion_tokens": 2,
                        },
                    }
                )
                + "\n\n",
                "data: [DONE]\n\n",
            ]
        )
        return httpx.Response(200, content=content, headers={"content-type": "text/event-stream"})

    runtime = AiRuntimeClient(
        control_plane_url="http://control.test",
        api_key=API_KEY,
        lkg_path=tmp_path / "stream.json",
        http_client=httpx.Client(transport=httpx.MockTransport(control)),
        provider_http_client=httpx.Client(transport=httpx.MockTransport(provider)),
        credentials={"OPENAI_API_KEY": "openai-secret"},
        now=lambda: NOW,
    )
    runtime.refresh()
    with ai_context(AiRuntimeContext(user_id="stream-user")):
        chunks = list(
            runtime.chat_stream(model="text.fast", messages=[{"role": "user", "content": "hello"}])
        )
    assert len(chunks) == 3
    assert provider_bodies[0]["model"] == "litellm-primary"
    assert provider_bodies[0]["stream"] is True
    assert provider_bodies[0]["stream_options"] == {"include_usage": True}
    event = batches[0]["events"][0]
    assert event["result"]["status"] == "success"
    assert event["usage"]["uncached_input_tokens"] == "5"
    assert event["usage"]["cache_read_input_tokens"] == "4"
    assert event["usage"]["output_tokens"] == "2"
    runtime.close()

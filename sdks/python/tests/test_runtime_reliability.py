from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from runtime_testkit import (
    API_KEY,
    NOW,
    SNAPSHOT,
    accepted_usage_response,
    hard_limit_snapshot,
    reservation_request,
    reservation_response,
    runtime_client,
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
    ProviderStreamPart,
    RecordUsageInput,
    RuntimeRouteContext,
    RuntimeSnapshot,
    ai_context,
    resolve_runtime_route,
    with_aiu_reservation,
)
from ai_control_sdk.runtime.usage_spool import DurableUsageSpool, UsageSpoolCapacityError


def test_route_rule_golden_cases_and_conflicts() -> None:
    def snapshot_with_rules(
        rules: list[dict[str, Any]], *, timezone: str = "UTC"
    ) -> RuntimeSnapshot:
        value = json.loads(json.dumps(SNAPSHOT))
        plan = value["routing"]["text.fast"]
        plan["timezone"] = timezone
        reversed_targets = [
            {**target, "fallback_order": index, "route_tag": "cp:text.fast:rule"}
            for index, target in enumerate(reversed(plan["default"]["targets"]))
        ]
        plan["rules"] = [
            {
                "id": f"rule-{index}",
                "priority": rule.pop("priority", 100),
                "match": rule,
                "route": {
                    "route_tag": "cp:text.fast:rule",
                    "selection_mode": "ordered",
                    "targets": reversed_targets,
                },
                **({"expires_at": "2026-07-16T14:00:00.000Z"} if "override_active" in rule else {}),
            }
            for index, rule in enumerate(rules)
        ]
        return RuntimeSnapshot.model_validate(signed_snapshot(value))

    cases: list[tuple[dict[str, Any], RuntimeRouteContext]] = [
        ({"user": {"ids": ["u-1"]}}, RuntimeRouteContext(user_id="u-1")),
        (
            {"user_property": {"key": "plan", "operator": "starts_with", "value": "pro"}},
            RuntimeRouteContext(user_properties={"plan": "professional"}),
        ),
        (
            {"user_property": {"key": "tags", "operator": "contains", "value": "vip"}},
            RuntimeRouteContext(user_properties={"tags": ["vip", "paid"]}),
        ),
        (
            {"user_property": {"key": "region", "operator": "is_not_set"}},
            RuntimeRouteContext(user_properties={}),
        ),
        ({"call_source": {"value": "parse"}}, RuntimeRouteContext(call_source="parse")),
        (
            {"schedule": {"days": [4], "from": "12:00", "to": "14:00"}},
            RuntimeRouteContext(),
        ),
        ({"override_active": True}, RuntimeRouteContext()),
    ]
    for match, context in cases:
        selected = resolve_runtime_route(snapshot_with_rules([match]), "text.fast", NOW, context)
        assert selected.rule_id == "rule-0"
        assert selected.primary.model_id == "model-fallback"

    overnight = snapshot_with_rules([{"schedule": {"days": [3], "from": "23:00", "to": "14:00"}}])
    assert resolve_runtime_route(overnight, "text.fast", NOW).rule_id == "rule-0"

    conflict = snapshot_with_rules(
        [
            {"priority": 100, "user": {"ids": ["u-1"]}},
            {"priority": 100, "call_source": {"value": "parse"}},
        ]
    )
    with pytest.raises(AiControlSdkError, match="winning priority"):
        resolve_runtime_route(
            conflict,
            "text.fast",
            NOW,
            RuntimeRouteContext(user_id="u-1", call_source="parse"),
        )
    with pytest.raises(AiControlSdkError, match="No active route"):
        resolve_runtime_route(conflict, "missing", NOW)


def test_durable_usage_spool_capacity_rejection_and_idempotency(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="positive"):
        DurableUsageSpool(tmp_path / "bad.sqlite3", 0)
    spool = DurableUsageSpool(tmp_path / "usage.sqlite3", 1_000_000)
    with pytest.raises(ValueError, match="event_id"):
        spool.enqueue({"status": "missing"})
    assert spool.enqueue({"event_id": "event-1", "value": 1}) is True
    assert spool.enqueue({"event_id": "event-1", "value": 2}) is False
    assert spool.depth == 1
    assert spool.pending(10)[0].payload == {"event_id": "event-1", "value": 1}
    spool.reject("event-1", "INVALID")
    assert spool.depth == 0
    assert spool.enqueue({"event_id": "event-1", "value": 3}) is False
    assert spool.enqueue({"event_id": "event-2"}) is True
    assert spool.acknowledge(["event-2", "missing"]) == 1
    spool.close()

    constrained = DurableUsageSpool(tmp_path / "tiny.sqlite3", 1)
    with pytest.raises(UsageSpoolCapacityError) as failure:
        constrained.enqueue({"event_id": "large-event", "value": "x" * 100})
    assert failure.value.maximum_bytes == 1
    constrained.close()


def test_reservation_helpers_release_after_model_failure(tmp_path: Path) -> None:
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.url.path.endswith("/release"):
            return httpx.Response(200, json={"status": "released"})
        return httpx.Response(200, json=reservation_response())

    runtime = runtime_client(tmp_path / "release.json", handler, snapshot=hard_limit_snapshot())
    runtime.refresh()
    with pytest.raises(RuntimeError, match="provider failed"):
        with_aiu_reservation(
            client=runtime,
            reservation=reservation_request(),
            operation=lambda _token: (_ for _ in ()).throw(RuntimeError("provider failed")),
            settled_aiu_micros=lambda _value: "0",
        )
    assert any(path.endswith("/release") for path in paths)
    runtime.close()


def test_async_client_lkg_etag_fail_open_and_registration_edges(tmp_path: Path) -> None:
    async def run() -> None:
        lkg_path = tmp_path / "async-lkg.json"
        writer = runtime_client(
            lkg_path,
            lambda _request: httpx.Response(404),
            snapshot=hard_limit_snapshot(),
        )
        writer.refresh()
        writer.close()

        class Adapter:
            requires_credential = False

            async def chat(self, _request: ProviderChatRequest) -> ProviderChatResponse:
                return ProviderChatResponse(response={})

            async def stream(
                self, _request: ProviderChatRequest
            ) -> AsyncProviderChatStreamResponse:
                async def empty() -> Any:
                    if False:
                        yield ProviderStreamPart(value={})

                return AsyncProviderChatStreamResponse(stream=empty())

        def control(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/runtime/snapshot":
                return httpx.Response(304)
            if request.url.path == "/runtime/configuration-acknowledgements":
                return httpx.Response(202)
            if request.url.path == "/runtime/users/aiu/reservations":
                raise httpx.ConnectError("offline", request=request)
            raise AssertionError(request.url.path)

        runtime = AsyncAiRuntimeClient(
            control_plane_url="http://control.test",
            api_key=API_KEY,
            lkg_path=lkg_path,
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(control)),
            refresh_interval_seconds=0,
            now=lambda: NOW,
        )
        assert await runtime.load_lkg() is True
        assert (await runtime.start()).status == "not_modified"
        assert runtime.select_route("text.fast").primary.model_id == "model-primary"
        result = await runtime.reserve_user_aiu(reservation_request())
        assert result.status == "fail_open"
        adapter = Adapter()
        assert runtime.register_provider_adapter("anthropic", adapter) is runtime
        assert runtime.register_connection_adapter("connection-primary", adapter) is runtime
        with pytest.raises(ValueError, match="driver"):
            runtime.register_provider_adapter("unknown", adapter)
        with pytest.raises(ValueError, match="connection_id"):
            runtime.register_connection_adapter(" ", adapter)
        await runtime.close()

    asyncio.run(run())


def test_manual_usage_requires_governed_model_and_caller_idempotency_ids(tmp_path: Path) -> None:
    batches: list[dict[str, Any]] = []

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
        lkg_path=tmp_path / "manual.json",
        http_client=httpx.Client(transport=httpx.MockTransport(control)),
        now=lambda: NOW,
    )
    runtime.refresh()
    with ai_context(
        AiRuntimeContext(
            user_id="manual-user",
            display_user="Manual User",
            operation_id="manual-operation-1",
            event_properties={"next_action": "review"},
            analytics_dimensions={"client": "python"},
        )
    ):
        event = runtime.record_usage(
            RecordUsageInput(
                event_id="01ARZ3NDEKTSV4RRFFQ69G5FAV",
                attempt_id="manual-attempt-1",
                model="text.fast",
                model_id="model-primary",
                latency_ms=42,
                usage={
                    "uncached_input_tokens": "6",
                    "output_tokens": "2",
                    "request_count": "1",
                },
            )
        )
    assert event["event_id"] == "01ARZ3NDEKTSV4RRFFQ69G5FAV"
    assert event["request"]["operation_id"] == "manual-operation-1"
    assert event["model"]["connection_id"] == "connection-primary"
    assert event["route"]["reason"] == "manual"
    assert event["privacy"] == {"contains_prompt": False, "contains_response": False}
    assert batches[0]["events"] == [event]

    with (
        ai_context(AiRuntimeContext(user_id="manual-user")),
        pytest.raises(AiControlSdkError, match="not a candidate"),
    ):
        runtime.record_usage(
            RecordUsageInput(
                event_id="01ARZ3NDEKTSV4RRFFQ69G5FAW",
                attempt_id="manual-attempt-2",
                model="text.fast",
                model_id="not-a-candidate",
                usage={"request_count": "1"},
            )
        )
    with (
        ai_context(AiRuntimeContext(user_id="manual-user")),
        pytest.raises(ValueError, match="usage contains"),
    ):
        runtime.record_usage(
            RecordUsageInput(
                event_id="01ARZ3NDEKTSV4RRFFQ69G5FAX",
                attempt_id="manual-attempt-3",
                model="text.fast",
                usage={"prompt": "must not leave the application"},
            )
        )
    runtime.close()

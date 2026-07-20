from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest

from ai_control_sdk import (
    AiControlSdkError,
    AiRuntimeClient,
    AiRuntimeContext,
    AsyncAiRuntimeClient,
    RuntimeConfigurationAcknowledgement,
    RuntimeRouteContext,
    ai_context,
    apply_ai_context_to_openai_request,
    async_ai_context,
    async_with_aiu_reservation,
    current_ai_context,
    with_aiu_reservation,
)

API_KEY = "python-sdk-runtime-key-0000001"
NOW = datetime(2026, 7, 16, 13, 0, tzinfo=UTC)


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def signed_snapshot(value: dict[str, Any]) -> dict[str, Any]:
    unsigned = {key: child for key, child in value.items() if key not in {"etag", "signature"}}
    etag = f"sha256:{hashlib.sha256(canonical(unsigned).encode()).hexdigest()}"
    binding = {"application_id": unsigned["application_id"], "etag": etag}
    return {
        **unsigned,
        "etag": etag,
        "signature": f"sha256:{hashlib.sha256(canonical(binding).encode()).hexdigest()}",
    }


SNAPSHOT = signed_snapshot(
    {
        "schema_version": "2.0",
        "application_id": "00000000-0000-4000-8000-000000000042",
        "version": "runtime-v42",
        "expires_at": "2026-07-16T14:00:00.000Z",
        "routing": {
            "text.fast": {
                "virtual_model_id": "virtual-fast",
                "configuration_version": 81,
                "configuration_etag": f"sha256:{'8' * 64}",
                "published_at": "2026-07-16T12:00:00.000Z",
                "timezone": "UTC",
                "default": {
                    "route_tag": "cp:text.fast:default",
                    "selection_mode": "ordered",
                    "targets": [
                        {
                            "model_id": "model-primary",
                            "model_tag": "litellm-primary",
                            "provider": "openai",
                            "route_tag": "cp:text.fast:default",
                            "fallback_order": 0,
                            "weight": 1,
                        },
                        {
                            "model_id": "model-fallback",
                            "model_tag": "litellm-fallback",
                            "provider": "anthropic",
                            "route_tag": "cp:text.fast:default",
                            "fallback_order": 1,
                            "weight": 1,
                        },
                    ],
                },
                "rules": [],
            }
        },
        "aiu": {"enabled": True, "mode": "observe", "unrated_model_policy": "alert_only"},
        "access": {"application_enabled": True, "blocked_user_ids": []},
        "dimensions": {
            "analytics_allowed_keys": ["client"],
        },
    }
)


def runtime_client(
    path: Path,
    handler: Any,
    *,
    snapshot: dict[str, Any] = SNAPSHOT,
    acknowledgements: list[dict[str, Any]] | None = None,
) -> AiRuntimeClient:
    collected = acknowledgements if acknowledgements is not None else []

    def transport(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/runtime/snapshot":
            return httpx.Response(200, json=snapshot)
        if request.url.path == "/runtime/configuration-acknowledgements":
            acknowledgement = RuntimeConfigurationAcknowledgement.model_validate(
                json.loads(request.content)
            )
            collected.append(acknowledgement.model_dump(mode="json"))
            return httpx.Response(202, json={"status": "accepted", "duplicate": False})
        return handler(request)

    return AiRuntimeClient(
        control_plane_url="http://control.test",
        api_key=API_KEY,
        lkg_path=path,
        http_client=httpx.Client(transport=httpx.MockTransport(transport)),
        now=lambda: NOW,
    )


def test_context_routing_metadata_and_configuration_acknowledgements(tmp_path: Path) -> None:
    acknowledgements: list[dict[str, Any]] = []
    runtime = runtime_client(
        tmp_path / "runtime.json",
        lambda _request: httpx.Response(404),
        acknowledgements=acknowledgements,
    )
    assert current_ai_context() is None
    assert runtime.refresh().status == "updated"
    with ai_context(
        AiRuntimeContext(
            user_id="user-1",
            display_user="Ada",
            application_version="ios-2.8.0",
            operation_id="op-1",
            parent_request_id="parent-request-1",
            session_id="session-1",
            conversation_id="conversation-1",
            call_source="receipt_parse",
            event_properties={"voice_enabled": True, "next_action": "confirm"},
            user_properties={"member_level": "VVIP"},
            analytics_dimensions={"client": "ios"},
        )
    ):
        body, options = apply_ai_context_to_openai_request(
            runtime,
            {
                "model": "text.fast",
                "metadata": {"cp": {"forged": True}, "cp:route": "forged", "safe": "kept"},
            },
            {"headers": {"X-LiteLLM-Tags": "customer,cp:forged"}},
        )
    assert current_ai_context() is None
    assert body["model"] == "litellm-primary"
    assert body["fallbacks"] == ["litellm-fallback"]
    assert body["metadata"]["cp_route"] == {
        "virtual_model": "text.fast",
        "route_tag": "cp:text.fast:default",
        "model_id": "model-primary",
        "model_tag": "litellm-primary",
        "configuration_version": 81,
        "fallback_model_ids": ["model-fallback"],
        "candidate_models": [
            {"model_id": "model-primary", "model_tag": "litellm-primary"},
            {"model_id": "model-fallback", "model_tag": "litellm-fallback"},
        ],
    }
    assert body["metadata"]["cp"]["user_id"] == "user-1"
    assert body["metadata"]["cp"]["display_user"] == "Ada"
    assert body["metadata"]["cp"]["application_version"] == "ios-2.8.0"
    assert body["metadata"]["cp"]["sdk_version"] == "0.2.0"
    assert body["metadata"]["cp"]["parent_request_id"] == "parent-request-1"
    assert body["metadata"]["cp"]["session_id"] == "session-1"
    assert body["metadata"]["cp"]["conversation_id"] == "conversation-1"
    assert body["metadata"]["cp"]["event_properties"] == {
        "voice_enabled": True,
        "next_action": "confirm",
    }
    assert body["metadata"]["cp"]["user_properties"] == {"member_level": "VVIP"}
    assert body["metadata"]["cp"]["call_source"] == "receipt_parse"
    assert options["headers"]["x-litellm-tags"].endswith(
        "cp:model:model-primary,cp:configuration:81"
    )
    assert "forged" not in json.dumps(body)
    assert [item["state"] for item in acknowledgements] == ["received", "applied"]
    assert all(item["configuration_etag"] == SNAPSHOT["etag"] for item in acknowledgements)
    runtime.close()


def test_rejected_snapshot_keeps_last_known_good_configuration(tmp_path: Path) -> None:
    served = 0
    acknowledgements: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal served
        if request.url.path == "/runtime/snapshot":
            served += 1
            return httpx.Response(
                200, json=SNAPSHOT if served == 1 else {**SNAPSHOT, "version": "tampered"}
            )
        if request.url.path == "/runtime/configuration-acknowledgements":
            item = RuntimeConfigurationAcknowledgement.model_validate(json.loads(request.content))
            acknowledgements.append(item.model_dump(mode="json"))
            return httpx.Response(202)
        raise AssertionError(request.url.path)

    runtime = AiRuntimeClient(
        control_plane_url="http://control.test",
        api_key=API_KEY,
        instance_id="python-test-instance",
        sdk_version="0.2.0-test",
        lkg_path=tmp_path / "runtime.json",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        now=lambda: NOW,
    )
    assert runtime.refresh().status == "updated"
    assert runtime.refresh().status == "lkg"
    assert runtime.select_route("text.fast").primary.model_id == "model-primary"
    assert [item["state"] for item in acknowledgements] == ["received", "applied", "rejected"]
    assert acknowledgements[-1]["connector"]["instance_id"] == "python-test-instance"
    runtime.close()


def test_rejects_snapshot_signature_bound_to_another_application(tmp_path: Path) -> None:
    invalid = {**SNAPSHOT, "signature": f"sha256:{'0' * 64}"}
    runtime = runtime_client(
        tmp_path / "runtime.json", lambda _request: httpx.Response(404), snapshot=invalid
    )
    with pytest.raises(AiControlSdkError, match="application binding"):
        runtime.refresh()
    runtime.close()


def test_weighted_default_route_is_deterministic(tmp_path: Path) -> None:
    weighted = json.loads(json.dumps(SNAPSHOT))
    route = weighted["routing"]["text.fast"]["default"]
    route["selection_mode"] = "weighted"
    route["targets"][0]["weight"] = 1
    route["targets"][1]["weight"] = 1_000
    runtime = runtime_client(
        tmp_path / "weighted-runtime.json",
        lambda _request: httpx.Response(404),
        snapshot=signed_snapshot(weighted),
    )
    runtime.refresh()

    selected = runtime.select_route("text.fast", RuntimeRouteContext(selection_key="req-weighted"))

    assert selected.primary.model_id == "model-fallback"
    assert [target.model_id for target in selected.fallbacks] == ["model-primary"]
    runtime.close()


def test_routes_with_user_properties_and_requires_user_id(tmp_path: Path) -> None:
    contextual = json.loads(json.dumps(SNAPSHOT))
    plan = contextual["routing"]["text.fast"]
    route_tag = "cp:text.fast:pro"
    targets = [
        {**target, "route_tag": route_tag, "fallback_order": index}
        for index, target in enumerate(reversed(plan["default"]["targets"]))
    ]
    plan["rules"] = [
        {
            "id": "pro-users",
            "priority": 100,
            "match": {
                "user_property": {"key": "member_level", "operator": "equals", "value": "pro"}
            },
            "route": {
                "route_tag": route_tag,
                "selection_mode": "ordered",
                "targets": targets,
            },
        }
    ]
    contextual = signed_snapshot(contextual)
    runtime = runtime_client(
        tmp_path / "runtime.json", lambda _request: httpx.Response(404), snapshot=contextual
    )
    runtime.refresh()
    selected = runtime.select_route(
        "text.fast",
        RuntimeRouteContext(user_id="user-1", user_properties={"member_level": "pro"}),
    )
    assert selected.primary.model_id == "model-fallback"
    with pytest.raises(ValueError, match="user_id"), ai_context(AiRuntimeContext(user_id=" ")):
        pass
    with (
        pytest.raises(ValueError, match=r"event_properties\.prompt"),
        ai_context(
            AiRuntimeContext(
                user_id="user-1", event_properties={"prompt": "must not leave the app"}
            )
        ),
    ):
        pass
    runtime.close()


def hard_limit_snapshot() -> dict[str, Any]:
    return signed_snapshot({**SNAPSHOT, "aiu": {**SNAPSHOT["aiu"], "mode": "hard_limit"}})


def reservation_response() -> dict[str, Any]:
    return {
        "allowed": True,
        "reason": "reserved",
        "user": {
            "id": "user-internal-1",
            "limit_aiu_micros": "1000",
            "used_aiu_micros": "0",
            "reserved_aiu_micros": "100",
            "remaining_aiu_micros": "900",
        },
        "reservation": {
            "id": "reservation-1",
            "token": "reservation-token-0123456789abcdef0123456789abcdef0123456789abcdef",
            "reserved_aiu_micros": "100",
            "expires_at": "2026-07-16T13:05:00.000Z",
        },
    }


def reservation_request() -> dict[str, Any]:
    return {
        "user_id": "user-1",
        "display_user": "Ada",
        "user_properties": {"member_level": "pro"},
        "operation_id": "op-1",
        "virtual_model": "text.fast",
        "candidate_model_ids": ["00000000-0000-4000-8000-000000000001"],
        "estimated_aiu_micros": "100",
    }


def test_application_user_reservation_settles_and_disabled_mode_has_no_network(
    tmp_path: Path,
) -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path.endswith("/settle"):
            return httpx.Response(200, json={"status": "settled"})
        return httpx.Response(200, json=reservation_response())

    observed = runtime_client(tmp_path / "observed.json", handler)
    observed.refresh()
    result = observed.reserve_user_aiu(reservation_request())
    assert result.status == "not_required"
    assert calls == []
    observed.close()

    strict = runtime_client(tmp_path / "strict.json", handler, snapshot=hard_limit_snapshot())
    strict.refresh()
    value, result = with_aiu_reservation(
        client=strict,
        reservation=reservation_request(),
        operation=lambda token: "called" if token else "missing",
        settled_aiu_micros=lambda _value: "80",
    )
    assert value == "called"
    assert result.status == "reserved"
    assert any(path.endswith("/settle") for path in calls)
    strict.close()


def test_async_client_uses_the_same_current_contract(tmp_path: Path) -> None:
    async def run() -> None:
        acknowledgements: list[str] = []
        paths: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            paths.append(request.url.path)
            if request.url.path == "/runtime/snapshot":
                return httpx.Response(200, json=hard_limit_snapshot())
            if request.url.path == "/runtime/configuration-acknowledgements":
                acknowledgements.append(json.loads(request.content)["state"])
                return httpx.Response(202)
            if request.url.path.endswith("/settle"):
                return httpx.Response(200, json={"status": "settled"})
            return httpx.Response(200, json=reservation_response())

        runtime = AsyncAiRuntimeClient(
            control_plane_url="http://control.test",
            api_key=API_KEY,
            lkg_path=tmp_path / "async.json",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            now=lambda: NOW,
        )
        assert (await runtime.refresh()).status == "updated"
        async with async_ai_context(AiRuntimeContext(user_id="user-async")):
            context = current_ai_context()
            assert context is not None
            assert context.user_id == "user-async"
        value, reservation = await async_with_aiu_reservation(
            client=runtime,
            reservation={**reservation_request(), "user_id": "user-async"},
            operation=lambda token: asyncio.sleep(0, result="called" if token else "missing"),
            settled_aiu_micros=lambda _value: "80",
        )
        assert value == "called"
        assert reservation.status == "reserved"
        assert acknowledgements == ["received", "applied"]
        assert any(path.endswith("/settle") for path in paths)
        await runtime.close()

    asyncio.run(run())


def test_fail_closed_preserves_authoritative_denial(tmp_path: Path) -> None:
    runtime = AiRuntimeClient(
        control_plane_url="http://control.test",
        api_key=API_KEY,
        lkg_path=tmp_path / "closed.json",
        fail_mode="fail_closed",
        http_client=httpx.Client(
            transport=httpx.MockTransport(
                lambda request: (
                    httpx.Response(200, json=hard_limit_snapshot())
                    if request.url.path == "/runtime/snapshot"
                    else httpx.Response(202)
                    if request.url.path == "/runtime/configuration-acknowledgements"
                    else httpx.Response(403, json={"reason": "quota_exhausted"})
                )
            )
        ),
        now=lambda: NOW,
    )
    runtime.refresh()
    with pytest.raises(httpx.HTTPStatusError):
        runtime.reserve_user_aiu(reservation_request())
    runtime.close()

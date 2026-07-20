from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from ai_control_litellm.quota import UserQuotaClient

from .helpers import connector_config

MODEL_ID = "00000000-0000-4000-8000-000000000904"
RESERVATION_ID = "00000000-0000-4000-8000-000000000905"


def routed_request() -> dict[str, object]:
    return {
        "model": "openai/gpt-5-mini",
        "metadata": {
            "cp": {
                "context_version": "1",
                "operation_id": "operation-42",
                "user_id": "customer-42",
                "display_user": "Ada",
                "user_properties": {"member_level": "pro"},
                "estimated_aiu_micros": "2500000",
            },
            "cp_route": {
                "virtual_model": "assistant",
                "candidate_model_ids": [MODEL_ID],
                "quota_mode": "hard_limit",
            },
        },
    }


def test_hard_limit_reserves_aiu_and_attaches_reservation_to_usage_context(tmp_path) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        assert request.headers["authorization"] == "Bearer policy-key-do-not-log"
        assert request.url.path == "/runtime/users/aiu/reservations"
        return httpx.Response(
            200,
            json={
                "allowed": True,
                "reason": "reserved",
                "reservation": {
                    "id": RESERVATION_ID,
                    "token": "secret-token-never-forwarded-to-usage",
                },
            },
        )

    async def run() -> dict[str, object]:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            client = UserQuotaClient(connector_config(tmp_path / "spool.sqlite3"), http)
            return await client.apply_to_request(routed_request())

    result = asyncio.run(run())
    assert captured == {
        "user_id": "customer-42",
        "display_user": "Ada",
        "user_properties": {"member_level": "pro"},
        "operation_id": "operation-42",
        "virtual_model": "assistant",
        "candidate_model_ids": [MODEL_ID],
        "estimated_aiu_micros": "2500000",
    }
    metadata = result["metadata"]
    assert isinstance(metadata, dict)
    cp = metadata["cp"]
    assert isinstance(cp, dict)
    assert cp["reservation_id"] == RESERVATION_ID
    assert "reservation_token" not in cp


def test_blocked_or_exhausted_user_stops_the_model_call(tmp_path) -> None:
    async def run() -> None:
        transport = httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                json={"allowed": False, "reason": "quota_exhausted", "reservation": None},
            )
        )
        async with httpx.AsyncClient(transport=transport) as http:
            client = UserQuotaClient(connector_config(tmp_path / "spool.sqlite3"), http)
            await client.apply_to_request(routed_request())

    with pytest.raises(PermissionError, match="quota_exhausted"):
        asyncio.run(run())


def test_hard_limit_rejects_missing_user_without_creating_an_anonymous_identity(tmp_path) -> None:
    request = routed_request()
    metadata = request["metadata"]
    assert isinstance(metadata, dict)
    cp = metadata["cp"]
    assert isinstance(cp, dict)
    del cp["user_id"]

    async def run() -> None:
        client = UserQuotaClient(connector_config(tmp_path / "spool.sqlite3"))
        await client.apply_to_request(request)

    with pytest.raises(PermissionError, match="user_id_required"):
        asyncio.run(run())


def test_non_hard_limit_never_adds_network_latency(tmp_path) -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500)

    request = routed_request()
    metadata = request["metadata"]
    assert isinstance(metadata, dict)
    route = metadata["cp_route"]
    assert isinstance(route, dict)
    route["quota_mode"] = "observe"

    async def run() -> dict[str, object]:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            client = UserQuotaClient(connector_config(tmp_path / "spool.sqlite3"), http)
            return await client.apply_to_request(request)

    assert asyncio.run(run()) == request
    assert calls == 0


def test_hard_limit_outage_is_fail_closed_by_default(tmp_path) -> None:
    async def run() -> None:
        transport = httpx.MockTransport(lambda _request: httpx.Response(503))
        async with httpx.AsyncClient(transport=transport) as http:
            client = UserQuotaClient(connector_config(tmp_path / "spool.sqlite3"), http)
            await client.apply_to_request(routed_request())

    with pytest.raises(RuntimeError, match="could not be verified"):
        asyncio.run(run())


def test_fail_open_can_be_selected_for_noncritical_installations(tmp_path) -> None:
    request = routed_request()

    async def run() -> dict[str, object]:
        transport = httpx.MockTransport(lambda _request: httpx.Response(503))
        async with httpx.AsyncClient(transport=transport) as http:
            config = connector_config(tmp_path / "spool.sqlite3", quota_fail_closed=False)
            client = UserQuotaClient(config, http)
            return await client.apply_to_request(request)

    assert asyncio.run(run()) == request

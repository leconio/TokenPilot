from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest

from ai_control_litellm import runtime_policy as runtime_policy_module
from ai_control_litellm.runtime_policy import RuntimePolicyClient

from .helpers import connector_config


def sign_snapshot(value: dict[str, Any]) -> dict[str, Any]:
    unsigned = {key: item for key, item in value.items() if key not in {"etag", "signature"}}
    checksum = hashlib.sha256(
        json.dumps(unsigned, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
    ).hexdigest()
    etag = f"sha256:{checksum}"
    binding = {"application_id": unsigned["application_id"], "etag": etag}
    signature = hashlib.sha256(
        json.dumps(binding, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
    ).hexdigest()
    return {**unsigned, "etag": etag, "signature": f"sha256:{signature}"}


def runtime_snapshot() -> dict[str, Any]:
    return sign_snapshot(
        {
            "schema_version": "2.0",
            "application_id": "00000000-0000-4000-8000-000000000901",
            "version": "runtime-policy-1",
            "expires_at": "2099-07-17T00:00:00.000Z",
            "connections": {
                "connection-litellm": {
                    "id": "connection-litellm",
                    "name": "LiteLLM",
                    "driver": "litellm",
                    "base_url": "http://litellm.test/v1",
                    "credential_ref": "LITELLM_API_KEY",
                    "timeout_ms": 60000,
                    "max_retries": 1,
                }
            },
            "routing": {
                "text.fast": {
                    "virtual_model_id": "virtual-fast",
                    "configuration_version": 17,
                    "configuration_etag": f"sha256:{'7' * 64}",
                    "published_at": "2026-07-16T00:00:00.000Z",
                    "timezone": "UTC",
                    "default": {
                        "route_tag": "cp:text.fast:default",
                        "selection_mode": "ordered",
                        "targets": [
                            {
                                "model_id": "model-primary",
                                "connection_id": "connection-litellm",
                                "request_model": "litellm-primary",
                                "provider": "openai",
                                "task_type": "chat",
                                "capabilities": ["streaming", "tools"],
                                "route_tag": "cp:text.fast:default",
                                "fallback_order": 0,
                                "weight": 1,
                            },
                            {
                                "model_id": "model-fallback",
                                "connection_id": "connection-litellm",
                                "request_model": "litellm-fallback",
                                "provider": "anthropic",
                                "task_type": "chat",
                                "capabilities": ["streaming", "tools"],
                                "route_tag": "cp:text.fast:default",
                                "fallback_order": 1,
                                "weight": 1,
                            },
                        ],
                    },
                    "rules": [],
                }
            },
            "aiu": {
                "enabled": True,
                "mode": "observe",
                "unrated_model_policy": "alert_only",
            },
            "access": {"application_enabled": True, "blocked_user_ids": []},
            "dimensions": {"analytics_allowed_keys": []},
        }
    )


def condition_route(snapshot: dict[str, Any], tag: str) -> dict[str, Any]:
    default = snapshot["routing"]["text.fast"]["default"]
    targets = [dict(default["targets"][1]), dict(default["targets"][0])]
    for index, target in enumerate(targets):
        target["route_tag"] = tag
        target["fallback_order"] = index
    return {"route_tag": tag, "selection_mode": "ordered", "targets": targets}


def test_local_snapshot_routes_by_user_group_projection_property_and_call_source(
    tmp_path: Path,
) -> None:
    snapshot = runtime_snapshot()
    plan = snapshot["routing"]["text.fast"]
    plan["rules"] = [
        {
            "id": "paid-users",
            "priority": 300,
            "match": {"user": {"ids": ["customer-42"]}},
            "route": condition_route(snapshot, "cp:text.fast:paid"),
        },
        {
            "id": "pro-users",
            "priority": 200,
            "match": {
                "user_property": {
                    "key": "member_level",
                    "operator": "equals",
                    "value": "pro",
                }
            },
            "route": condition_route(snapshot, "cp:text.fast:pro"),
        },
        {
            "id": "voice-calls",
            "priority": 100,
            "match": {"call_source": {"value": "voice"}},
            "route": condition_route(snapshot, "cp:text.fast:voice"),
        },
    ]
    snapshot.pop("etag")
    snapshot = sign_snapshot(snapshot)
    config = connector_config(tmp_path / "spool.sqlite3", policy_api_key=None)
    policy = RuntimePolicyClient(config)
    policy._snapshot = runtime_policy_module._verified_snapshot(
        snapshot, datetime(2026, 7, 18, tzinfo=UTC), allow_expired=False
    )

    routed = policy.apply_to_request(
        {
            "model": "text.fast",
            "metadata": {
                "cp": {
                    "context_version": "1",
                    "user_id": "customer-42",
                    "user_properties": {"member_level": "pro"},
                    "event_properties": {"call_source": "voice"},
                }
            },
        }
    )

    assert routed["model"] == "litellm-fallback"
    metadata = routed["metadata"]
    assert isinstance(metadata, dict)
    assert metadata["route_tag"] == "cp:text.fast:paid"
    policy.stop()


def test_property_routing_uses_json_type_equality_and_javascript_text_conversion(
    tmp_path: Path,
) -> None:
    snapshot = runtime_snapshot()
    plan = snapshot["routing"]["text.fast"]
    plan["rules"] = [
        {
            "id": "numeric-plan",
            "priority": 200,
            "match": {"user_property": {"key": "plan", "operator": "equals", "value": 1}},
            "route": condition_route(snapshot, "cp:text.fast:numeric"),
        },
        {
            "id": "boolean-prefix",
            "priority": 100,
            "match": {
                "user_property": {
                    "key": "feature",
                    "operator": "starts_with",
                    "value": True,
                }
            },
            "route": condition_route(snapshot, "cp:text.fast:boolean-prefix"),
        },
    ]
    snapshot.pop("etag")
    snapshot = sign_snapshot(snapshot)
    policy = RuntimePolicyClient(connector_config(tmp_path / "spool.sqlite3", policy_api_key=None))
    policy._snapshot = runtime_policy_module._verified_snapshot(
        snapshot, datetime(2026, 7, 18, tzinfo=UTC), allow_expired=False
    )

    routed = policy.apply_to_request(
        {
            "model": "text.fast",
            "metadata": {
                "cp": {
                    "context_version": "1",
                    "user_properties": {"plan": True, "feature": "true-preview"},
                }
            },
        }
    )
    metadata = routed["metadata"]
    assert isinstance(metadata, dict)
    assert metadata["route_tag"] == "cp:text.fast:boolean-prefix"
    policy.stop()


def test_last_known_snapshot_blocks_an_application_user_without_network_access(
    tmp_path: Path,
) -> None:
    snapshot = runtime_snapshot()
    snapshot["access"]["blocked_user_ids"] = ["blocked-user"]
    snapshot.pop("etag")
    snapshot = sign_snapshot(snapshot)
    policy = RuntimePolicyClient(connector_config(tmp_path / "spool.sqlite3", policy_api_key=None))
    policy._snapshot = runtime_policy_module._verified_snapshot(
        snapshot, datetime(2026, 7, 18, tzinfo=UTC), allow_expired=False
    )

    with pytest.raises(PermissionError, match="user_blocked"):
        policy.apply_to_request(
            {
                "model": "text.fast",
                "metadata": {"cp": {"context_version": "1", "user_id": "blocked-user"}},
            }
        )
    policy.stop()


def test_expired_snapshot_is_not_accepted_as_last_known_good() -> None:
    snapshot = runtime_snapshot()
    snapshot["expires_at"] = "2026-07-17T00:00:00.000Z"
    snapshot = sign_snapshot(snapshot)

    with pytest.raises(ValueError, match="expired"):
        runtime_policy_module._verified_snapshot(
            snapshot, datetime(2026, 7, 18, tzinfo=UTC), allow_expired=False
        )


def test_poll_apply_ack_invalid_candidate_and_disconnected_lkg(tmp_path: Path) -> None:
    candidate = runtime_snapshot()
    invalid = {**candidate, "version": "runtime-policy-corrupt"}
    invalid_order = runtime_snapshot()
    invalid_order["routing"]["text.fast"]["default"]["targets"][0]["fallback_order"] = 1
    invalid_order.pop("etag")
    invalid_order = sign_snapshot(invalid_order)
    served = 0
    acknowledgements: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal served
        assert request.headers["authorization"] == "Bearer policy-key-do-not-log"
        if request.url.path == "/runtime/snapshot":
            served += 1
            response = candidate if served == 1 else invalid if served == 2 else invalid_order
            return httpx.Response(200, json=response)
        if request.url.path == "/runtime/configuration-acknowledgements":
            acknowledgements.append(json.loads(request.content))
            return httpx.Response(202, json={"status": "accepted", "duplicate": False})
        raise AssertionError(f"unexpected request: {request.url}")

    config = connector_config(
        tmp_path / "spool.sqlite3",
        policy_lkg_path=tmp_path / "runtime.json",
    )
    policy = RuntimePolicyClient(config)
    policy._client.close()
    policy._client = httpx.Client(transport=httpx.MockTransport(handler))
    assert policy.refresh_once() == "updated"
    assert [item["state"] for item in acknowledgements] == ["received", "applied"]
    assert all(
        item["application_id"] == "00000000-0000-4000-8000-000000000901"
        for item in acknowledgements
    )

    routed = policy.apply_to_request(
        {"model": "text.fast", "metadata": {"tags": ["customer", "cp:forged"]}}
    )
    assert routed["model"] == "litellm-primary"
    assert routed["fallbacks"] == [{"litellm-primary": ["litellm-fallback"]}]
    metadata = routed["metadata"]
    assert isinstance(metadata, dict)
    assert metadata["route_tag"] == "cp:text.fast:default"
    assert "tags" not in metadata
    assert metadata["cp_route"]["route_tag"] == "cp:text.fast:default"
    assert metadata["cp_route"]["candidate_models"] == [
        {
            "model_id": "model-primary",
            "connection_id": "connection-litellm",
            "request_model": "litellm-primary",
        },
        {
            "model_id": "model-fallback",
            "connection_id": "connection-litellm",
            "request_model": "litellm-fallback",
        },
    ]

    with pytest.raises(ValueError, match="checksum"):
        policy.refresh_once()
    assert acknowledgements[-1]["state"] == "rejected"
    assert policy.select_route("text.fast").primary["model_id"] == "model-primary"

    with pytest.raises(ValueError, match="fallback order"):
        policy.refresh_once()
    assert acknowledgements[-1]["state"] == "rejected"
    assert policy.select_route("text.fast").primary["model_id"] == "model-primary"
    policy.stop()

    disconnected = RuntimePolicyClient(
        connector_config(
            tmp_path / "disconnected-spool.sqlite3",
            policy_lkg_path=tmp_path / "runtime.json",
        )
    )
    assert disconnected.load_lkg() is True
    selected = disconnected.select_route("text.fast", datetime(2026, 7, 16, tzinfo=UTC))
    assert selected.primary["request_model"] == "litellm-primary"
    assert disconnected.apply_to_request({"model": "text.fast"})["model"] == "litellm-primary"
    disconnected.stop()


def test_ingestion_key_is_never_reused_and_required_policy_fails_closed_without_snapshot(
    tmp_path: Path,
) -> None:
    config = connector_config(
        tmp_path / "spool.sqlite3",
        api_key="ingestion-key-must-not-be-used-for-policy",
        policy_api_key=None,
        policy_required=True,
    )
    policy = RuntimePolicyClient(config)
    request = {"model": "text.fast", "metadata": {"feature": "assistant"}}

    with pytest.raises(RuntimeError, match="No trusted Runtime Snapshot"):
        policy.apply_to_request(request)
    with pytest.raises(ValueError, match="policy API key"):
        policy.refresh_once()
    assert policy._thread is None
    policy.stop()


def test_lkg_is_applied_before_optional_applied_ack_is_retried(tmp_path: Path) -> None:
    candidate = runtime_snapshot()
    acknowledgement_states: list[str] = []
    applied_attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal applied_attempts
        assert request.headers["authorization"] == "Bearer policy-key-do-not-log"
        if request.url.path == "/runtime/snapshot":
            if request.headers.get("if-none-match") is not None:
                return httpx.Response(304)
            return httpx.Response(200, json=candidate)
        if request.url.path == "/runtime/configuration-acknowledgements":
            acknowledgement = json.loads(request.content)
            state = str(acknowledgement["state"])
            acknowledgement_states.append(state)
            if state == "applied":
                applied_attempts += 1
                if applied_attempts == 1:
                    return httpx.Response(503)
            return httpx.Response(202, json={"status": "accepted", "duplicate": False})
        raise AssertionError(f"unexpected request: {request.url}")

    config = connector_config(
        tmp_path / "spool.sqlite3",
        policy_lkg_path=tmp_path / "runtime.json",
    )
    policy = RuntimePolicyClient(config)
    policy._client.close()
    policy._client = httpx.Client(transport=httpx.MockTransport(handler))

    assert policy.refresh_once() == "updated"
    assert policy.select_route("text.fast").primary["request_model"] == "litellm-primary"
    assert config.policy_lkg_path.exists()
    assert acknowledgement_states == ["received", "applied"]

    assert policy.refresh_once() == "not_modified"
    assert acknowledgement_states == ["received", "applied", "applied"]
    policy.stop()


def test_restart_reconfirms_the_durable_lkg_and_rejects_another_policy_key(
    tmp_path: Path,
) -> None:
    candidate = runtime_snapshot()
    acknowledgements: list[dict[str, object]] = []

    def initial_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/runtime/snapshot":
            return httpx.Response(200, json=candidate)
        if request.url.path == "/runtime/configuration-acknowledgements":
            acknowledgements.append(json.loads(request.content))
            return httpx.Response(202, json={"status": "accepted", "duplicate": False})
        raise AssertionError(f"unexpected request: {request.url}")

    config = connector_config(
        tmp_path / "spool.sqlite3",
        policy_lkg_path=tmp_path / "runtime.json",
    )
    initial = RuntimePolicyClient(config)
    initial._client.close()
    initial._client = httpx.Client(transport=httpx.MockTransport(initial_handler))
    assert initial.refresh_once() == "updated"
    initial.stop()

    restarted_states: list[str] = []

    def restarted_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/runtime/configuration-acknowledgements":
            acknowledgement = json.loads(request.content)
            restarted_states.append(str(acknowledgement["state"]))
            return httpx.Response(202, json={"status": "accepted", "duplicate": False})
        if request.url.path == "/runtime/snapshot":
            assert request.headers["if-none-match"] == f'"{candidate["etag"]}"'
            return httpx.Response(304)
        raise AssertionError(f"unexpected request: {request.url}")

    restarted = RuntimePolicyClient(config)
    restarted._client.close()
    restarted._client = httpx.Client(transport=httpx.MockTransport(restarted_handler))
    assert restarted.load_lkg() is True
    assert restarted.refresh_once() == "not_modified"
    assert restarted_states == ["applied"]
    restarted.stop()

    wrong_key = RuntimePolicyClient(
        connector_config(
            tmp_path / "other-spool.sqlite3",
            policy_api_key="another-application-policy-key",
            policy_lkg_path=config.policy_lkg_path,
        )
    )
    with pytest.raises(ValueError, match="policy-key binding mismatch"):
        wrong_key.load_lkg()
    with pytest.raises(RuntimeError, match="No trusted Runtime Snapshot"):
        wrong_key.apply_to_request({"model": "text.fast"})
    wrong_key.stop()

    missing_key = RuntimePolicyClient(
        connector_config(
            tmp_path / "missing-key-spool.sqlite3",
            policy_api_key=None,
            policy_lkg_path=config.policy_lkg_path,
        )
    )
    with pytest.raises(ValueError, match="policy API key is required"):
        missing_key.load_lkg()
    with pytest.raises(RuntimeError, match="No trusted Runtime Snapshot"):
        missing_key.apply_to_request({"model": "text.fast"})
    missing_key.stop()

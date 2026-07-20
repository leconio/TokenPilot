from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from ai_control_sdk import (
    AiRuntimeClient,
    RuntimeConfigurationAcknowledgement,
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
        "connections": {
            "connection-primary": {
                "id": "connection-primary",
                "name": "Primary OpenAI",
                "driver": "openai_compatible",
                "base_url": "https://api.openai.test/v1",
                "credential_ref": "OPENAI_API_KEY",
                "timeout_ms": 30000,
                "max_retries": 1,
            },
            "connection-fallback": {
                "id": "connection-fallback",
                "name": "Fallback Anthropic",
                "driver": "anthropic",
                "base_url": "https://api.anthropic.test/v1",
                "credential_ref": "ANTHROPIC_API_KEY",
                "timeout_ms": 30000,
                "max_retries": 0,
                "api_version": "2023-06-01",
            },
        },
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
                            "connection_id": "connection-primary",
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
                            "connection_id": "connection-fallback",
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


def accepted_usage_response(request: httpx.Request) -> httpx.Response:
    batch = json.loads(request.content)
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

from __future__ import annotations

from pathlib import Path
from typing import Any

from ai_control_litellm.config import ConnectorConfig
from ai_control_litellm.mapper import map_standard_payload
from ai_control_litellm.standard_payload import extract_standard_logging_payload


def connector_config(path: Path, **overrides: object) -> ConnectorConfig:
    values: dict[str, object] = {
        "control_plane_url": "https://control.example.test",
        "api_key": "control-plane-key-do-not-log",
        "policy_api_key": "policy-key-do-not-log",
        "instance_id": "litellm-test-instance",
        "spool_path": path,
        "batch_size": 100,
        "flush_interval_seconds": 0.01,
        "request_timeout_seconds": 0.1,
        "retry_base_seconds": 1.0,
        "retry_max_seconds": 10.0,
        "lease_seconds": 30.0,
        "heartbeat_interval_seconds": 0.05,
        "max_spool_bytes": 20 * 1024 * 1024,
        "sender_enabled": True,
    }
    values.update(overrides)
    return ConnectorConfig(**values)  # type: ignore[arg-type]


def standard_kwargs(call_id: str = "call-001") -> dict[str, object]:
    return {
        "messages": [{"role": "user", "content": "PROMPT_SENTINEL"}],
        "api_key": "PROVIDER_KEY_SENTINEL",
        "standard_logging_object": {
            "id": call_id,
            "trace_id": "trace-001",
            "status": "success",
            "model": "openai/gpt-5-mini",
            "model_id": "openai-fast-prod",
            "model_group": "text.fast",
            "prompt_tokens": 100,
            "completion_tokens": 20,
            "cache_hit": False,
            "response_cost": 0.00125,
            "startTime": 1_784_107_000.0,
            "endTime": 1_784_107_000.25,
            "litellm_version": "1.92.0",
            "messages": [{"content": "STANDARD_PROMPT_SENTINEL"}],
            "response": "RESPONSE_SENTINEL",
            "metadata": {
                "feature": "assistant",
                "end_user_id": "user-123",
                "trace_id": "trace-allowlisted",
                "business_request_id": "business-request-123",
                "virtual_model": "text.fast",
                "configuration_version": 7,
                "route_tag": "cp:text.fast:peak",
                "authorization": "Bearer AUTH_SENTINEL",
                "user_api_key": "USER_KEY_SENTINEL",
                "unapproved": "UNAPPROVED_SENTINEL",
                "usage_object": {
                    "prompt_tokens": 100,
                    "completion_tokens": 20,
                    "prompt_tokens_details": {"cached_tokens": 25},
                    "completion_tokens_details": {"reasoning_tokens": 5},
                },
            },
        },
        "litellm_params": {
            "model_info": {"id": "fallback-deployment"},
            "metadata": {
                "headers": {"authorization": "Bearer RAW_SECRET"},
                "cp": {
                    "context_version": "1",
                    "user_id": "user-123",
                    "display_user": "Test user",
                },
            },
        },
    }


def usage_event(path: Path, call_id: str = "call-001") -> dict[str, Any]:
    kwargs = standard_kwargs(call_id)
    payload = extract_standard_logging_payload(kwargs)
    return map_standard_payload(payload, connector_config(path))

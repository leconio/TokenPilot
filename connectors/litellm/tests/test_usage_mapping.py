from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest

from ai_control_litellm.config import ConnectorConfig
from ai_control_litellm.contracts import CanonicalUsageEvent
from ai_control_litellm.mapper import map_standard_payload
from ai_control_litellm.standard_payload import extract_standard_logging_payload

from .helpers import connector_config

FIXTURES = Path(__file__).parent / "fixtures" / "current"


def load_fixture(name: str) -> dict[str, Any]:
    value: object = json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))
    assert isinstance(value, dict)
    return value


def map_fixture(name: str, tmp_path: Path) -> dict[str, Any]:
    payload = extract_standard_logging_payload(load_fixture(name))
    return map_standard_payload(payload, connector_config(tmp_path / "spool.sqlite3"))


def test_connector_uses_the_canonical_usage_endpoint() -> None:
    assert ConnectorConfig().ingestion_url.endswith("/usage-events/batch")
    assert "/v" not in ConnectorConfig().ingestion_url


def test_connector_reads_separate_ingestion_and_policy_keys(monkeypatch) -> None:
    monkeypatch.setenv("AI_CONTROL_API_KEY", "ingestion-key")
    monkeypatch.setenv("AI_CONTROL_POLICY_API_KEY", "policy-key")

    config = ConnectorConfig.from_environment()

    assert config.api_key == "ingestion-key"
    assert config.policy_api_key == "policy-key"
    assert "ingestion-key" not in repr(config)
    assert "policy-key" not in repr(config)


def test_connector_keys_are_never_projected_into_usage_events(tmp_path) -> None:
    config = connector_config(
        tmp_path / "spool.sqlite3",
        api_key="INGESTION_KEY_SENTINEL",
        policy_api_key="POLICY_KEY_SENTINEL",
    )
    payload = extract_standard_logging_payload(load_fixture("success"))

    event = map_standard_payload(payload, config)
    wire = json.dumps(event, sort_keys=True)

    assert "INGESTION_KEY_SENTINEL" not in wire
    assert "POLICY_KEY_SENTINEL" not in wire


def test_success_fixture_maps_exclusive_usage_and_node_metadata(tmp_path) -> None:
    event = map_fixture("success", tmp_path)
    CanonicalUsageEvent.model_validate(event)

    assert event["schema_version"] == "2.0"
    assert event["model"] == {
        "virtual_model": "text.fast",
        "model_id": "019c0000-0000-7000-8000-000000000001",
        "connection_id": "019c0000-0000-7000-8000-000000000101",
        "connection_driver": "litellm",
        "request_model": "openai-fast-prod-a",
        "provider": "openai",
    }
    assert event["request"] == {
        "request_id": "req_success_01",
        "attempt_id": "provider-response-success-01",
        "attempt_index": 0,
        "is_final_attempt": True,
        "operation_id": "op_success_01",
        "parent_request_id": None,
        "session_id": None,
        "conversation_id": None,
        "trace_id": "trace_success_01",
    }
    assert event["usage"] == {
        "uncached_input_tokens": "250",
        "cache_read_input_tokens": "700",
        "cache_write_input_tokens": "50",
        "output_tokens": "200",
        "reasoning_output_tokens": "40",
        "request_count": "1",
    }
    assert event["route"]["tags"] == ["cp:route:offpeak"]
    assert event["analytics_dimensions"] == {"client": "ios", "region": "tw"}
    assert event["user"] == {"user_id": "user_123", "display_user": "Ada"}
    assert event["application_version"] == "2026.7.18"
    assert event["sdk_version"] == "0.2.0"
    assert event["event_properties"] == {
        "next_action": "summarize",
        "voice_enabled": True,
    }
    assert event["user_properties"] == {
        "member_level": "VVIP",
        "interests": ["AI", "voice"],
    }
    assert event["privacy"] == {"contains_prompt": False, "contains_response": False}
    wire = json.dumps(event, sort_keys=True)
    assert "FORGED_VVIP" not in wire
    assert "FORGED_USER" not in wire
    assert "PROMPT_MUST_NOT_LEAVE_CALLBACK" not in wire
    assert "RESPONSE_MUST_NOT_LEAVE_CALLBACK" not in wire


def test_runtime_candidate_mapping_attributes_a_fallback_to_the_real_model(tmp_path) -> None:
    fixture = deepcopy(load_fixture("success"))
    fixture["standard_logging_object"]["model_group"] = "text.fast.demo-fallback"
    fixture["litellm_params"]["metadata"]["cp_route"] = {
        "route_tag": "cp:virtual:acceptance.chat:default",
        "candidate_models": [
            {
                "model_id": "019c0000-0000-7000-8000-000000000001",
                "request_model": "text.fast.demo-primary",
            },
            {
                "model_id": "019c0000-0000-7000-8000-000000000002",
                "request_model": "text.fast.demo-fallback",
            },
        ],
    }

    event = map_standard_payload(
        extract_standard_logging_payload(fixture),
        connector_config(tmp_path / "spool.sqlite3"),
    )

    assert event["model"]["model_id"] == "019c0000-0000-7000-8000-000000000002"
    assert event["model"]["request_model"] == "text.fast.demo-fallback"
    assert "cp:virtual:acceptance.chat:default" in event["route"]["tags"]


def test_failure_and_fallback_are_correlated_distinct_attempts(tmp_path) -> None:
    failure = map_fixture("failure", tmp_path)
    fallback = map_fixture("fallback", tmp_path)

    assert failure["result"] == {
        "status": "failure",
        "http_status": 429,
        "latency_ms": 120,
        "error_class": "RateLimitError",
    }
    assert failure["usage"] == {"request_count": "1"}
    assert failure["route"]["is_final_success_attempt"] is False
    assert fallback["route"] == {
        "configuration_version": None,
        "rule": None,
        "reason": None,
        "tags": ["cp:route:fallback"],
        "fallback_from": "anthropic-primary-prod",
        "is_final_success_attempt": True,
    }
    assert failure["request"]["operation_id"] == fallback["request"]["operation_id"]
    assert failure["request"]["request_id"] == fallback["request"]["request_id"]
    assert failure["request"]["attempt_id"] != fallback["request"]["attempt_id"]
    assert fallback["usage"] == {
        "uncached_input_tokens": "300",
        "cache_read_input_tokens": "500",
        "output_tokens": "120",
        "reasoning_output_tokens": "30",
        "request_count": "1",
    }
    assert "PRIVATE_FALLBACK_PROMPT" not in json.dumps(fallback)
    assert "PRIVATE_PROVIDER_ERROR_BODY" not in json.dumps(failure)


def test_shared_litellm_call_id_keeps_provider_attempts_distinct(tmp_path) -> None:
    failure_kwargs = deepcopy(load_fixture("failure"))
    fallback_kwargs = deepcopy(load_fixture("fallback"))
    failure_kwargs["standard_logging_object"]["litellm_call_id"] = "shared-router-call"
    fallback_kwargs["standard_logging_object"]["litellm_call_id"] = "shared-router-call"

    failure = map_standard_payload(
        extract_standard_logging_payload(failure_kwargs),
        connector_config(tmp_path / "spool.sqlite3"),
    )
    fallback = map_standard_payload(
        extract_standard_logging_payload(fallback_kwargs),
        connector_config(tmp_path / "spool.sqlite3"),
    )

    assert failure["request"]["attempt_id"] == "attempt-fallback-primary"
    assert fallback["request"]["attempt_id"] == "attempt-fallback-success"
    assert failure["event_id"] != fallback["event_id"]


def test_streaming_fixture_emits_only_final_usage_and_supported_seconds(tmp_path) -> None:
    event = map_fixture("streaming", tmp_path)

    assert event["request"]["attempt_id"] == "attempt-stream-final"
    assert event["route"]["is_final_success_attempt"] is True
    assert event["usage"] == {
        "uncached_input_tokens": "400",
        "output_tokens": "80",
        "output_audio_seconds": "1.25",
        "request_count": "1",
    }
    assert event["user"] == {"user_id": "stream-user", "display_user": "Stream user"}


def test_application_user_metadata_does_not_require_a_signature(tmp_path) -> None:
    kwargs = deepcopy(load_fixture("success"))
    metadata = kwargs["litellm_params"]["metadata"]
    cp = metadata["cp"]
    cp.pop("nonce", None)
    event = map_standard_payload(
        extract_standard_logging_payload(kwargs),
        connector_config(tmp_path / "spool.sqlite3"),
    )

    assert event["usage"]["request_count"] == "1"
    assert event["user"] == {"user_id": "user_123", "display_user": "Ada"}


def test_invalid_reserved_context_cannot_supply_required_user(tmp_path) -> None:
    kwargs = deepcopy(load_fixture("success"))
    kwargs["litellm_params"]["metadata"]["cp"]["context_version"] = "invalid context version"
    with pytest.raises(ValueError, match="user_id"):
        map_standard_payload(
            extract_standard_logging_payload(kwargs),
            connector_config(tmp_path / "spool.sqlite3"),
        )


def test_ordinary_metadata_identity_is_ignored_without_reserved_cp(tmp_path) -> None:
    kwargs = load_fixture("success")
    metadata = kwargs["litellm_params"]["metadata"]
    del metadata["cp"]
    metadata.update({"member_level": "VVIP", "end_user_id": "attacker"})
    with pytest.raises(ValueError, match="user_id"):
        map_standard_payload(
            extract_standard_logging_payload(kwargs),
            connector_config(tmp_path / "spool.sqlite3"),
        )


def test_supported_multimodal_and_embedding_usage_is_preserved(tmp_path) -> None:
    kwargs = {
        "standard_logging_object": {
            "id": "attempt-multimodal",
            "status": "success",
            "model": "provider/multimodal-model",
            "model_id": "multimodal-prod",
            "model_group": "multimodal.default",
            "startTime": "2026-07-16T04:00:00.000Z",
            "endTime": "2026-07-16T04:00:00.500Z",
            "metadata": {
                "usage_object": {
                    "input_images": 2,
                    "output_images": 1,
                    "audio_input_seconds": 1.5,
                    "audio_output_seconds": 2.25,
                    "input_video_seconds": 3.5,
                    "output_video_seconds": 4.75,
                    "embedding_tokens": 512,
                }
            },
        },
        "litellm_params": {
            "metadata": {
                "cp": {
                    "context_version": "1",
                    "user_id": "multimodal-user",
                    "display_user": "Multimodal user",
                }
            }
        },
    }
    event = map_standard_payload(
        extract_standard_logging_payload(kwargs),
        connector_config(tmp_path / "spool.sqlite3"),
    )

    assert event["usage"] == {
        "input_images": "2",
        "output_images": "1",
        "input_audio_seconds": "1.5",
        "output_audio_seconds": "2.25",
        "input_video_seconds": "3.5",
        "output_video_seconds": "4.75",
        "embedding_tokens": "512",
        "request_count": "1",
    }

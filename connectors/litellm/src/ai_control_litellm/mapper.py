"""Canonical, content-free Usage Event mapper for LiteLLM attempts."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from .config import ConnectorConfig
from .context import project_context
from .contracts import CanonicalUsageEvent
from .identifiers import stable_event_id
from .standard_payload import Metric, StandardLoggingPayload, Timestamp

_VIRTUAL_MODEL = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
_OPAQUE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$")


def _datetime(value: Timestamp, fallback: datetime | None = None) -> datetime:
    if isinstance(value, datetime):
        result = value
    elif isinstance(value, int | float):
        result = datetime.fromtimestamp(value, UTC)
    elif isinstance(value, str):
        try:
            result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            result = fallback or datetime.now(UTC)
    else:
        result = fallback or datetime.now(UTC)
    if result.tzinfo is None:
        result = result.replace(tzinfo=UTC)
    return result.astimezone(UTC)


def _rfc3339(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _bounded(value: object, limit: int = 256) -> str | None:
    if not isinstance(value, str):
        return None
    result = value.strip()
    return result[:limit] if result else None


def _opaque(value: object, *, prefix: str, fallback_seed: str) -> str:
    candidate = _bounded(value)
    if candidate is not None and _OPAQUE_ID.fullmatch(candidate):
        return candidate
    return f"{prefix}_{stable_event_id(fallback_seed).lower()}"


def _provider(payload: StandardLoggingPayload) -> str | None:
    if payload.provider is not None:
        return payload.provider.lower()[:256]
    if payload.model is not None and "/" in payload.model:
        return payload.model.split("/", 1)[0].lower()[:256]
    return None


def _decimal(metric: Metric | None) -> Decimal | None:
    return None if metric is None else Decimal(str(metric.value))


def _wire_decimal(value: Decimal) -> str:
    return format(max(Decimal(0), value), "f")


def _exclusive_usage(payload: StandardLoggingPayload) -> dict[str, object]:
    metrics = payload.metrics
    usage: dict[str, object] = {}
    total_input = _decimal(metrics.get("input_tokens"))
    cache_read = _decimal(metrics.get("cache_read_input_tokens"))
    cache_write = _decimal(metrics.get("cache_write_input_tokens"))
    cache_total = (cache_read or Decimal(0)) + (cache_write or Decimal(0))
    input_metric = metrics.get("input_tokens")
    anthropic_uncached = (
        _provider(payload) == "anthropic"
        and input_metric is not None
        and input_metric.source_field.endswith("input_tokens")
    )
    if total_input is not None:
        uncached = total_input
        if not anthropic_uncached and total_input >= cache_total:
            uncached -= cache_total
        usage["uncached_input_tokens"] = _wire_decimal(uncached)
    if cache_read is not None:
        usage["cache_read_input_tokens"] = _wire_decimal(cache_read)
    if cache_write is not None:
        usage["cache_write_input_tokens"] = _wire_decimal(cache_write)

    output = _decimal(metrics.get("output_tokens"))
    reasoning_metric = metrics.get("reasoning_output_tokens")
    reasoning = _decimal(reasoning_metric)
    reasoning_is_separate = reasoning_metric is not None and reasoning_metric.source_field.endswith(
        "thoughts_token_count"
    )
    if output is not None:
        exclusive_output = output
        if reasoning is not None and not reasoning_is_separate and output >= reasoning:
            exclusive_output -= reasoning
        usage["output_tokens"] = _wire_decimal(exclusive_output)
    if reasoning is not None:
        usage["reasoning_output_tokens"] = _wire_decimal(reasoning)

    direct_fields = {
        "input_images": "input_images",
        "output_images": "output_images",
        "audio_input_seconds": "input_audio_seconds",
        "audio_output_seconds": "output_audio_seconds",
        "video_input_seconds": "input_video_seconds",
        "video_output_seconds": "output_video_seconds",
        "embedding_tokens": "embedding_tokens",
    }
    for metric_name, wire_name in direct_fields.items():
        value = _decimal(metrics.get(metric_name))
        if value is not None:
            usage[wire_name] = _wire_decimal(value)
    # An attempt remains billable/observable even when a failed provider reports no tokens.
    usage["request_count"] = "1"
    return usage


def _status(value: str) -> str:
    normalized = value.lower()
    if "timeout" in normalized:
        return "timeout"
    if "cancel" in normalized:
        return "cancelled"
    if "fail" in normalized or "error" in normalized:
        return "failure"
    if "success" in normalized:
        return "success"
    return "unknown"


def map_standard_payload(
    payload: StandardLoggingPayload,
    config: ConnectorConfig,
    *,
    callback_end_time: datetime | None = None,
    callback_status: str | None = None,
) -> dict[str, Any]:
    """Build and validate one canonical event without retaining model content."""

    end_time = _datetime(payload.end_time, callback_end_time)
    start_time = _datetime(payload.start_time, end_time)
    status = _status(callback_status or payload.status)
    projection = project_context(payload.cp)
    request_id = _opaque(
        projection.request_id or payload.trace_id,
        prefix="req",
        fallback_seed=payload.call_id,
    )
    attempt_id = _opaque(payload.call_id, prefix="att", fallback_seed=payload.call_id)
    trace_id = projection.trace_id or _bounded(payload.trace_id)
    if trace_id is not None and _OPAQUE_ID.fullmatch(trace_id) is None:
        trace_id = None
    virtual_model = projection.virtual_model or _bounded(payload.model_group, 120)
    if virtual_model is not None and _VIRTUAL_MODEL.fullmatch(virtual_model) is None:
        virtual_model = None
    http_status = payload.http_status
    if http_status is None and status == "success":
        http_status = 200
    request_model = (
        payload.routed_request_model or projection.request_model or _bounded(payload.model)
    )
    if request_model is None:
        raise ValueError("LiteLLM did not provide the real model tag")
    model_id = payload.routed_model_id or projection.model_id
    fallback_from = _bounded(payload.fallback_from)
    if fallback_from == model_id:
        fallback_from = None

    source_cost = None
    if payload.response_cost is not None:
        source_cost = {
            "amount": format(payload.response_cost, "f"),
            "currency": "USD",
            "is_estimated": True,
        }
    request: dict[str, object] = {
        "request_id": request_id,
        "attempt_id": attempt_id,
        "attempt_index": payload.attempt_index,
        "is_final_attempt": status == "success" or payload.is_last_candidate,
        "operation_id": projection.operation_id,
        "parent_request_id": projection.parent_request_id,
        "session_id": projection.session_id,
        "conversation_id": projection.conversation_id,
        "trace_id": trace_id,
    }
    if projection.reservation_id is not None:
        request["reservation_id"] = projection.reservation_id
    event: dict[str, Any] = {
        "schema_version": "2.0",
        "event_id": stable_event_id(payload.call_id),
        "event_time": _rfc3339(end_time),
        "source": {
            "type": "gateway",
            "name": "litellm",
            "version": payload.litellm_version or config.connector_version,
            "instance_id": config.instance_id,
        },
        "request": request,
        "model": {
            "virtual_model": virtual_model,
            "model_id": model_id,
            "connection_id": payload.routed_connection_id or projection.connection_id,
            "connection_driver": projection.connection_driver or "litellm",
            "request_model": request_model,
            "provider": _provider(payload),
        },
        "route": {
            "configuration_version": projection.configuration_version,
            "rule": None,
            "reason": None,
            "tags": list(payload.route_tags),
            "fallback_from": fallback_from,
            "is_final_success_attempt": status == "success",
        },
        "analytics_dimensions": projection.analytics_dimensions,
        "result": {
            "status": status,
            "http_status": http_status,
            "latency_ms": max(0, int((end_time - start_time).total_seconds() * 1000)),
            "error_class": _bounded(payload.error_code),
        },
        "source_cost": source_cost,
        "privacy": {"contains_prompt": False, "contains_response": False},
        "usage": _exclusive_usage(payload),
    }
    if projection.application_version is not None:
        event["application_version"] = projection.application_version
    if projection.configuration_version is not None:
        event["config_version"] = projection.configuration_version
    if projection.sdk_version is not None:
        event["sdk_version"] = projection.sdk_version
    if projection.user_id is None:
        raise ValueError("metadata.cp.user_id is required")
    event["user"] = {
        "user_id": projection.user_id,
        "display_user": projection.display_user,
    }
    if projection.event_properties:
        event["event_properties"] = projection.event_properties
    if projection.user_properties:
        event["user_properties"] = projection.user_properties
    validated = CanonicalUsageEvent.model_validate(event)
    return validated.model_dump(mode="json", by_alias=True, exclude_unset=True)

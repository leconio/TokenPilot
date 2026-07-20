"""Narrow, content-free view of LiteLLM's Standard Logging Payload."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation

from .context import extract_reserved_cp
from .standard_metrics import Metric, extract_metrics

type Timestamp = str | int | float | datetime | None

_ROUTE_TAG = re.compile(r"^cp:[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+$")


class StandardPayloadError(ValueError):
    """Raised when LiteLLM does not provide a usable Standard Logging Payload."""


@dataclass(frozen=True, slots=True)
class StandardLoggingPayload:
    """Only fields that are safe and required to construct a canonical usage event."""

    call_id: str
    trace_id: str | None
    status: str
    model: str | None
    model_id: str | None
    model_group: str | None
    routed_model_id: str | None
    routed_connection_id: str | None
    routed_request_model: str | None
    attempt_index: int
    is_last_candidate: bool
    provider: str | None
    fallback_from: str | None
    route_tags: tuple[str, ...]
    cp: Mapping[str, object] | None
    metrics: Mapping[str, Metric]
    response_cost: Decimal | None
    start_time: Timestamp
    end_time: Timestamp
    error_code: str | None
    http_status: int | None
    litellm_version: str | None


def _mapping(value: object) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return {str(key): child for key, child in value.items()}
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        dumped = model_dump(mode="python")
        if isinstance(dumped, Mapping):
            return {str(key): child for key, child in dumped.items()}
    return {}


def _path(root: Mapping[str, object], *parts: str) -> object:
    current: object = root
    for part in parts:
        current_mapping = _mapping(current)
        if part not in current_mapping:
            return None
        current = current_mapping[part]
    return current


def _bounded_string(value: object, limit: int = 256) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped[:limit] if stripped else None


def _integer(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, float):
        return int(value) if value >= 0 and value.is_integer() else None
    return None


def _http_status(*values: object) -> int | None:
    for value in values:
        candidate: object = value
        if isinstance(candidate, str) and candidate.isdigit():
            candidate = int(candidate)
        parsed = _integer(candidate)
        if parsed is not None and 100 <= parsed <= 599:
            return parsed
    return None


def _decimal(value: object) -> Decimal | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return result if result.is_finite() and result >= 0 else None


def _first_string(*values: object) -> str | None:
    for value in values:
        candidate = _bounded_string(value)
        if candidate is not None:
            return candidate
    return None


def _timestamp(value: object) -> Timestamp:
    if isinstance(value, str | int | float | datetime) or value is None:
        return value
    return None


def _previous_deployment_id(
    *metadata_values: object, current_deployment_id: str | None = None
) -> str | None:
    """Project only the last failed deployment ID from LiteLLM fallback breadcrumbs."""

    for metadata_value in metadata_values:
        previous_models = _mapping(metadata_value).get("previous_models")
        if not isinstance(previous_models, list):
            continue
        for previous in reversed(previous_models):
            previous_mapping = _mapping(previous)
            for candidate in (
                _path(previous_mapping, "metadata", "model_info", "id"),
                _path(previous_mapping, "litellm_metadata", "model_info", "id"),
                _path(previous_mapping, "litellm_params", "model_info", "id"),
                _path(previous_mapping, "model_info", "id"),
            ):
                deployment_id = _bounded_string(candidate)
                if deployment_id is not None and deployment_id != current_deployment_id:
                    return deployment_id
    return None


def _route_tags(*values: object) -> tuple[str, ...]:
    output: list[str] = []
    for value in values:
        candidates: Sequence[object]
        if isinstance(value, str):
            candidates = value.split(",")
        elif isinstance(value, list | tuple):
            candidates = list(value)
        else:
            continue
        for candidate in candidates:
            tag = _bounded_string(candidate, 200)
            if tag is not None and _ROUTE_TAG.fullmatch(tag) and tag not in output:
                output.append(tag)
                if len(output) == 16:
                    return tuple(output)
    return tuple(output)


def _routed_model(
    model_group: str | None, *metadata_values: object
) -> tuple[str | None, str | None, str | None, int, bool]:
    if model_group is None:
        return None, None, None, 0, True
    for metadata in metadata_values:
        route = _mapping(_mapping(metadata).get("cp_route"))
        candidates = route.get("candidate_models")
        if not isinstance(candidates, list):
            continue
        for index, raw_candidate in enumerate(candidates):
            candidate = _mapping(raw_candidate)
            model_id = _bounded_string(candidate.get("model_id"))
            connection_id = _bounded_string(candidate.get("connection_id"))
            request_model = _bounded_string(candidate.get("request_model"))
            if model_id is not None and request_model == model_group:
                return model_id, connection_id, request_model, index, index == len(candidates) - 1
    return None, None, None, 0, True


def extract_standard_logging_payload(kwargs: Mapping[str, object]) -> StandardLoggingPayload:
    """Extract the official standard payload and discard all content-bearing fields."""

    payload = _mapping(kwargs.get("standard_logging_object"))
    if not payload:
        raise StandardPayloadError("standard_logging_object is missing")
    call_id = _first_string(
        # Router fallbacks can retain one LiteLLM call ID across provider
        # attempts. The standard payload ID identifies the individual attempt
        # and therefore must win whenever LiteLLM supplies it.
        payload.get("id"),
        payload.get("litellm_call_id"),
        payload.get("call_id"),
    )
    if call_id is None:
        raise StandardPayloadError("standard_logging_object attempt identifier is missing")

    metadata_raw = _mapping(payload.get("metadata"))
    requester_metadata = _mapping(metadata_raw.get("requester_metadata"))
    error_information = _mapping(payload.get("error_information"))
    response_information = _mapping(payload.get("response_information"))
    callback_response_information = _mapping(kwargs.get("response_information"))
    litellm_params = _mapping(kwargs.get("litellm_params"))
    raw_metadata = _mapping(litellm_params.get("metadata"))
    raw_litellm_metadata = _mapping(litellm_params.get("litellm_metadata"))
    model_info = _mapping(litellm_params.get("model_info"))
    direct_model_info = _mapping(kwargs.get("model_info"))
    deployment_id = _first_string(
        payload.get("model_id"),
        model_info.get("id"),
        direct_model_info.get("id"),
        _path(metadata_raw, "model_info", "id"),
    )
    provider = _first_string(
        payload.get("custom_llm_provider"),
        payload.get("provider"),
        error_information.get("llm_provider"),
        litellm_params.get("custom_llm_provider"),
    )
    http_status = _http_status(
        error_information.get("status_code"),
        error_information.get("error_code"),
        response_information.get("status_code"),
        payload.get("status_code"),
        callback_response_information.get("status_code"),
        kwargs.get("status_code"),
    )
    error_code = _first_string(
        error_information.get("error_class"),
        error_information.get("error_type"),
        error_information.get("error_code")
        if isinstance(error_information.get("error_code"), str)
        else None,
    )
    status = _first_string(payload.get("status"), kwargs.get("status")) or "success"

    model_group = _first_string(payload.get("model_group"), kwargs.get("model"))
    (
        routed_model_id,
        routed_connection_id,
        routed_request_model,
        attempt_index,
        is_last_candidate,
    ) = _routed_model(
        model_group,
        raw_metadata,
        raw_litellm_metadata,
        metadata_raw,
        requester_metadata,
    )
    return StandardLoggingPayload(
        call_id=call_id,
        trace_id=_first_string(payload.get("trace_id"), metadata_raw.get("trace_id")),
        status=status,
        model=_first_string(payload.get("model")),
        model_id=deployment_id,
        model_group=model_group,
        routed_model_id=routed_model_id,
        routed_connection_id=routed_connection_id,
        routed_request_model=routed_request_model,
        attempt_index=attempt_index,
        is_last_candidate=is_last_candidate,
        provider=provider,
        fallback_from=_previous_deployment_id(
            raw_metadata,
            raw_litellm_metadata,
            metadata_raw,
            current_deployment_id=deployment_id,
        ),
        route_tags=_route_tags(
            _path(raw_metadata, "cp_route", "route_tag"),
            _path(raw_litellm_metadata, "cp_route", "route_tag"),
            _path(metadata_raw, "cp_route", "route_tag"),
            _path(requester_metadata, "cp_route", "route_tag"),
            payload.get("request_tags"),
            payload.get("tags"),
            metadata_raw.get("tags"),
            requester_metadata.get("tags"),
            raw_metadata.get("tags"),
            raw_litellm_metadata.get("tags"),
            litellm_params.get("tags"),
        ),
        cp=extract_reserved_cp(
            raw_metadata,
            requester_metadata,
            metadata_raw,
            raw_litellm_metadata,
        ),
        metrics=extract_metrics(payload),
        response_cost=_decimal(payload.get("response_cost")),
        start_time=_timestamp(payload.get("startTime") or payload.get("start_time")),
        end_time=_timestamp(payload.get("endTime") or payload.get("end_time")),
        error_code=error_code,
        http_status=http_status,
        litellm_version=_bounded_string(
            payload.get("litellm_version") or kwargs.get("litellm_version"), 64
        ),
    )

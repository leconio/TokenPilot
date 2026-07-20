"""Reserved ``metadata.cp`` extraction for application usage metadata."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass

from pydantic import ValidationError

from .contracts import AnalyticsDimensions

_CONTEXT_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$")
_OPAQUE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$")
_CP_KEYS = frozenset(
    {
        "context_version",
        "operation_id",
        "analytics_dimensions",
        "request_id",
        "parent_request_id",
        "session_id",
        "conversation_id",
        "trace_id",
        "user_id",
        "display_user",
        "application_version",
        "sdk_version",
        "event_properties",
        "user_properties",
        "estimated_aiu_micros",
        "reservation_id",
        "virtual_model",
        "model_id",
        "model_tag",
        "configuration_version",
    }
)


@dataclass(frozen=True, slots=True)
class ContextProjection:
    """Validated application, user, request and custom-property metadata."""

    analytics_dimensions: dict[str, str | int | bool]
    request_id: str | None
    operation_id: str | None
    parent_request_id: str | None
    session_id: str | None
    conversation_id: str | None
    trace_id: str | None
    user_id: str | None
    display_user: str | None
    application_version: str | None
    sdk_version: str | None
    event_properties: dict[str, str | int | float | bool | list[str]]
    user_properties: dict[str, str | int | float | bool | list[str]]
    reservation_id: str | None
    virtual_model: str | None
    model_id: str | None
    model_tag: str | None
    configuration_version: str | None


def _mapping(value: object) -> Mapping[str, object]:
    return value if isinstance(value, Mapping) else {}


def _scalar_map(value: object) -> dict[str, str | int | bool]:
    output: dict[str, str | int | bool] = {}
    for key, child in _mapping(value).items():
        if isinstance(child, bool | int | str) and not isinstance(child, float):
            output[str(key)] = child
    return output


def _property_map(value: object) -> dict[str, str | int | float | bool | list[str]]:
    output: dict[str, str | int | float | bool | list[str]] = {}
    for key, child in _mapping(value).items():
        if isinstance(child, bool | int | float | str):
            output[str(key)] = child
        elif isinstance(child, list) and all(isinstance(item, str) for item in child):
            output[str(key)] = child[:32]
    return output


def extract_reserved_cp(*metadata_values: object) -> dict[str, object] | None:
    """Select one reserved namespace and immediately discard every unknown key."""

    for metadata_value in metadata_values:
        candidate = _mapping(metadata_value).get("cp")
        if not isinstance(candidate, Mapping):
            continue
        projected: dict[str, object] = {}
        for key in _CP_KEYS:
            value = candidate.get(key)
            if key == "analytics_dimensions":
                projected[key] = _scalar_map(value)
            elif key in {"event_properties", "user_properties"}:
                projected[key] = _property_map(value)
            elif isinstance(value, str):
                projected[key] = value
        return projected
    return None


def _identifier(value: object) -> str | None:
    return value if isinstance(value, str) and _OPAQUE_ID.fullmatch(value) else None


def _bounded_text(value: object, maximum: int) -> str | None:
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    return candidate[:maximum] if candidate else None


def _analytics(value: object) -> dict[str, str | int | bool]:
    candidate = _scalar_map(value)
    try:
        return dict(AnalyticsDimensions.model_validate(candidate).root)
    except ValidationError:
        return {}


def project_context(cp: Mapping[str, object] | None) -> ContextProjection:
    """Validate the SDK envelope without turning malformed context into model-call failure."""

    empty = ContextProjection(
        analytics_dimensions={},
        request_id=None,
        operation_id=None,
        parent_request_id=None,
        session_id=None,
        conversation_id=None,
        trace_id=None,
        user_id=None,
        display_user=None,
        application_version=None,
        sdk_version=None,
        event_properties={},
        user_properties={},
        reservation_id=None,
        virtual_model=None,
        model_id=None,
        model_tag=None,
        configuration_version=None,
    )
    if cp is None:
        return empty
    context_version = cp.get("context_version")
    if not isinstance(context_version, str) or _CONTEXT_VERSION.fullmatch(context_version) is None:
        return empty

    request_id = _identifier(cp.get("request_id"))
    operation_id = _identifier(cp.get("operation_id"))
    parent_request_id = _identifier(cp.get("parent_request_id"))
    session_id = _identifier(cp.get("session_id"))
    conversation_id = _identifier(cp.get("conversation_id"))
    trace_id = _identifier(cp.get("trace_id"))
    analytics = _analytics(cp.get("analytics_dimensions"))
    user_id = _bounded_text(cp.get("user_id"), 256)
    display_user = _bounded_text(cp.get("display_user"), 256)
    application_version = _bounded_text(cp.get("application_version"), 64)
    sdk_version = _bounded_text(cp.get("sdk_version"), 64)
    event_properties = _property_map(cp.get("event_properties"))
    user_properties = _property_map(cp.get("user_properties"))
    reservation_id = _identifier(cp.get("reservation_id"))
    virtual_model = _bounded_text(cp.get("virtual_model"), 120)
    model_id = _identifier(cp.get("model_id"))
    model_tag = _bounded_text(cp.get("model_tag"), 256)
    configuration_version = _bounded_text(cp.get("configuration_version"), 64)

    return ContextProjection(
        analytics_dimensions=analytics,
        request_id=request_id,
        operation_id=operation_id,
        parent_request_id=parent_request_id,
        session_id=session_id,
        conversation_id=conversation_id,
        trace_id=trace_id,
        user_id=user_id,
        display_user=display_user,
        application_version=application_version,
        sdk_version=sdk_version,
        event_properties=event_properties,
        user_properties=user_properties,
        reservation_id=reservation_id,
        virtual_model=virtual_model,
        model_id=model_id,
        model_tag=model_tag,
        configuration_version=configuration_version,
    )

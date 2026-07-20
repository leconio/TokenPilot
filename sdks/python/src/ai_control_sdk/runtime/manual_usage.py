"""Strict manual usage recording for providers not yet covered by a built-in adapter."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from ..errors import AiControlSdkError
from .context import ResolvedAiRuntimeContext, require_ai_context
from .contracts import OPAQUE_ID_PATTERN, ULID_PATTERN, RuntimeCallConnection, RuntimeRouteTarget
from .routing import RuntimeRouteContext, RuntimeRouteSelection

ResultStatus = Literal["success", "failure", "cancelled", "timeout", "unknown"]
ALLOWED_USAGE_KEYS = frozenset(
    {
        "uncached_input_tokens",
        "cache_read_input_tokens",
        "cache_write_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
        "input_images",
        "output_images",
        "input_audio_seconds",
        "output_audio_seconds",
        "input_video_seconds",
        "output_video_seconds",
        "embedding_tokens",
        "request_count",
        "custom_units",
    }
)


@dataclass(frozen=True, slots=True)
class RecordUsageInput:
    event_id: str
    attempt_id: str
    model: str
    usage: Mapping[str, Any]
    model_id: str | None = None
    attempt_index: int = 0
    is_final_attempt: bool = True
    status: ResultStatus = "success"
    http_status: int | None = None
    latency_ms: int | None = None
    error_class: str | None = None
    fallback_from: str | None = None


class ManualUsageClient(Protocol):
    connector_identity: Any

    @property
    def snapshot(self) -> Any: ...

    def select_route(
        self, virtual_model: str, context: RuntimeRouteContext | None = None
    ) -> RuntimeRouteSelection: ...

    def create_metadata_envelope(self, context: ResolvedAiRuntimeContext) -> dict[str, Any]: ...

    def now(self) -> Any: ...


def _target(route: RuntimeRouteSelection, model_id: str | None) -> RuntimeRouteTarget:
    candidates = (route.primary, *route.fallbacks)
    if model_id is None:
        return route.primary
    selected = next((candidate for candidate in candidates if candidate.model_id == model_id), None)
    if selected is None:
        raise AiControlSdkError(
            "SDK_MANUAL_USAGE_MODEL_INVALID",
            "The reported real model is not a candidate of the selected virtual model.",
        )
    return selected


def build_manual_usage_event(client: ManualUsageClient, input: RecordUsageInput) -> dict[str, Any]:
    if re.fullmatch(ULID_PATTERN, input.event_id) is None:
        raise ValueError("event_id must be a ULID")
    if OPAQUE_ID_PATTERN.fullmatch(input.attempt_id) is None:
        raise ValueError("attempt_id is invalid")
    if not 0 <= input.attempt_index <= 63:
        raise ValueError("attempt_index must be between 0 and 63")
    unknown = set(input.usage) - ALLOWED_USAGE_KEYS
    if not input.usage or unknown:
        detail = ", ".join(sorted(unknown)) if unknown else "no usage buckets"
        raise ValueError(f"usage contains {detail}")
    context = require_ai_context()
    route = client.select_route(
        input.model,
        RuntimeRouteContext(
            user_id=context.user_id,
            user_properties=context.user_properties,
            call_source=context.call_source,
            selection_key=context.request_id,
        ),
    )
    target = _target(route, input.model_id)
    snapshot = client.snapshot
    connection: RuntimeCallConnection | None = (
        None if snapshot is None else snapshot.connections.get(target.connection_id)
    )
    if connection is None:
        raise AiControlSdkError(
            "SDK_MANUAL_USAGE_CONNECTION_INVALID",
            "The reported real model references an unknown connection.",
        )
    metadata = client.create_metadata_envelope(context)
    return {
        "schema_version": "2.0",
        "event_id": input.event_id,
        "event_time": client.now().isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        **(
            {"application_version": context.application_version}
            if context.application_version is not None
            else {}
        ),
        "sdk_version": client.connector_identity.version,
        "config_version": str(route.configuration_version),
        "user": {"user_id": context.user_id, "display_user": context.display_user},
        **({"event_properties": context.event_properties} if context.event_properties else {}),
        **({"user_properties": context.user_properties} if context.user_properties else {}),
        "source": {
            "type": "sdk",
            "name": "tokenpilot-python",
            "version": client.connector_identity.version,
            "instance_id": client.connector_identity.instance_id,
        },
        "request": {
            "request_id": context.request_id,
            "attempt_id": input.attempt_id,
            "attempt_index": input.attempt_index,
            "is_final_attempt": input.is_final_attempt,
            "operation_id": context.operation_id,
            "parent_request_id": context.parent_request_id,
            "session_id": context.session_id,
            "conversation_id": context.conversation_id,
            "trace_id": context.trace_id,
            "reservation_id": None,
        },
        "model": {
            "virtual_model": route.virtual_model,
            "model_id": target.model_id,
            "connection_id": target.connection_id,
            "connection_driver": connection.driver,
            "request_model": target.request_model,
            "provider": target.provider,
        },
        "route": {
            "configuration_version": str(route.configuration_version),
            "rule": route.rule_id,
            "reason": "manual",
            "tags": [route.route_tag],
            "fallback_from": input.fallback_from,
            "is_final_success_attempt": input.status == "success",
            "is_user_visible_operation": input.is_final_attempt,
        },
        "analytics_dimensions": metadata.get("analytics_dimensions", {}),
        "result": {
            "status": input.status,
            "http_status": input.http_status,
            "latency_ms": input.latency_ms,
            "error_class": input.error_class,
        },
        "source_cost": None,
        "privacy": {"contains_prompt": False, "contains_response": False},
        "usage": dict(input.usage),
    }

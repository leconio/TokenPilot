"""Routing, reservation, and privacy-safe event helpers shared by chat modes."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from ..errors import AiControlSdkError
from .chat_types import AiChatAttempt, AsyncChatClient, SyncChatClient
from .context import ResolvedAiRuntimeContext, new_ulid
from .contracts import RuntimeCallConnection, RuntimeRouteTarget
from .routing import RuntimeRouteContext, RuntimeRouteSelection


def route_and_targets(
    client: SyncChatClient | AsyncChatClient,
    model: str,
    context: ResolvedAiRuntimeContext,
    messages: Sequence[Mapping[str, Any]],
    tools: Sequence[Mapping[str, Any]] | None,
    response_format: Mapping[str, Any] | None = None,
    *,
    streaming: bool = False,
) -> tuple[RuntimeRouteSelection, list[RuntimeRouteTarget]]:
    route = client.select_route(
        model,
        RuntimeRouteContext(
            user_id=context.user_id,
            user_properties=context.user_properties,
            call_source=context.call_source,
            selection_key=context.request_id,
        ),
    )
    targets = [route.primary, *route.fallbacks]
    required_input_capabilities: set[str] = set()
    for message in messages:
        content = message.get("content")
        if not isinstance(content, Sequence) or isinstance(content, str | bytes | bytearray):
            continue
        for part in content:
            if not isinstance(part, Mapping):
                continue
            if part.get("type") in {"image", "image_url", "input_image"}:
                required_input_capabilities.add("image_input")
            if part.get("type") in {"audio", "input_audio"}:
                required_input_capabilities.add("audio_input")
    if tools is not None:
        targets = [target for target in targets if "tools" in target.capabilities]
    if response_format is not None:
        targets = [target for target in targets if "structured_output" in target.capabilities]
    if streaming:
        targets = [target for target in targets if "streaming" in target.capabilities]
    if required_input_capabilities:
        targets = [
            target
            for target in targets
            if required_input_capabilities.issubset(target.capabilities)
        ]
    if not targets:
        raise AiControlSdkError(
            "SDK_MODEL_CAPABILITY_UNAVAILABLE",
            "No route target supports the requested chat capabilities.",
        )
    return route, targets


def reservation_request(
    context: ResolvedAiRuntimeContext,
    model: str,
    targets: Sequence[RuntimeRouteTarget],
    estimated_aiu_micros: str | None,
) -> dict[str, Any]:
    value: dict[str, Any] = {
        "user_id": context.user_id,
        "operation_id": context.operation_id,
        "virtual_model": model,
        "candidate_model_ids": [target.model_id for target in targets],
        "estimated_aiu_micros": estimated_aiu_micros or "0",
    }
    if context.display_user is not None:
        value["display_user"] = context.display_user
    if context.user_properties:
        value["user_properties"] = context.user_properties
    return value


def usage_event(
    client: SyncChatClient | AsyncChatClient,
    context: ResolvedAiRuntimeContext,
    route: RuntimeRouteSelection,
    targets: Sequence[RuntimeRouteTarget],
    target_index: int,
    connection: RuntimeCallConnection,
    attempt: AiChatAttempt,
    usage: Mapping[str, str],
    *,
    final: bool,
    reservation_id: str | None,
) -> dict[str, Any]:
    target = targets[target_index]
    prior = targets[target_index - 1] if target_index > 0 else None
    return {
        "schema_version": "2.0",
        "event_id": new_ulid().upper(),
        "event_time": utc_now(),
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
            "attempt_id": attempt.attempt_id,
            "attempt_index": attempt.attempt_index,
            "is_final_attempt": final,
            "operation_id": context.operation_id,
            "parent_request_id": context.parent_request_id,
            "session_id": context.session_id,
            "conversation_id": context.conversation_id,
            "trace_id": context.trace_id,
            "reservation_id": reservation_id,
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
            "reason": "default" if route.rule_id is None else "condition",
            "tags": [route.route_tag],
            "fallback_from": prior.model_id if prior is not None else None,
            "is_final_success_attempt": attempt.status == "success",
            "is_user_visible_operation": final,
        },
        "analytics_dimensions": context.analytics_dimensions,
        "result": {
            "status": attempt.status,
            "http_status": attempt.http_status,
            "latency_ms": attempt.latency_ms,
            "error_class": None if attempt.status == "success" else f"provider_{attempt.status}",
        },
        "source_cost": None,
        "privacy": {"contains_prompt": False, "contains_response": False},
        "usage": dict(usage),
    }


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")

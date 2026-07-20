"""OpenAI-compatible request decoration for one application user."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Protocol

from .context import ResolvedAiRuntimeContext, require_ai_context
from .routing import RuntimeRouteContext, RuntimeRouteSelection


def sanitize_caller_tags(tags: str | Iterable[str] | None) -> tuple[str, ...]:
    if tags is None:
        values: list[str] = []
    elif isinstance(tags, str):
        values = tags.split(",")
    else:
        values = [part for value in tags for part in value.split(",")]
    return tuple(tag.strip() for tag in values if tag.strip() and not tag.strip().startswith("cp:"))


class RuntimeMetadataClient(Protocol):
    def create_metadata_envelope(self, context: ResolvedAiRuntimeContext) -> dict[str, Any]: ...

    def select_route(
        self, virtual_model: str, context: RuntimeRouteContext | None = None
    ) -> RuntimeRouteSelection: ...


def apply_ai_context_to_openai_request(
    client: RuntimeMetadataClient,
    body: Mapping[str, Any],
    options: Mapping[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    context = require_ai_context()
    virtual_model = body.get("model")
    if not isinstance(virtual_model, str):
        raise TypeError("OpenAI-compatible requests must name a virtual model.")
    route = client.select_route(
        virtual_model,
        RuntimeRouteContext(
            user_id=context.user_id,
            user_properties=context.user_properties,
            call_source=context.call_source,
            selection_key=context.request_id,
        ),
    )
    output_options = dict(options or {})
    raw_headers = output_options.get("headers")
    headers = dict(raw_headers) if isinstance(raw_headers, Mapping) else {}
    existing = next(
        (str(value) for key, value in headers.items() if str(key).lower() == "x-litellm-tags"),
        None,
    )
    headers = {
        str(key): str(value)
        for key, value in headers.items()
        if str(key).lower() != "x-litellm-tags"
    }
    headers["x-litellm-tags"] = ",".join(
        (
            *sanitize_caller_tags(existing),
            route.route_tag,
            f"cp:model:{route.primary.model_id}",
            f"cp:configuration:{route.configuration_version}",
        )
    )
    output_options["headers"] = headers

    output_body = dict(body)
    raw_metadata = body.get("metadata")
    metadata = dict(raw_metadata) if isinstance(raw_metadata, Mapping) else {}
    metadata = {
        str(key): value
        for key, value in metadata.items()
        if str(key) != "cp" and not str(key).startswith(("cp:", "cp_"))
    }
    metadata["cp"] = client.create_metadata_envelope(context)
    metadata["cp_route"] = {
        "virtual_model": route.virtual_model,
        "route_tag": route.route_tag,
        "model_id": route.primary.model_id,
        "model_tag": route.primary.model_tag,
        "configuration_version": route.configuration_version,
        "fallback_model_ids": [target.model_id for target in route.fallbacks],
        "candidate_models": [
            {"model_id": target.model_id, "model_tag": target.model_tag}
            for target in (route.primary, *route.fallbacks)
        ],
    }
    output_body["model"] = route.primary.model_tag
    output_body["fallbacks"] = [target.model_tag for target in route.fallbacks]
    output_body["metadata"] = metadata
    return output_body, output_options

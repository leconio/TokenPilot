"""Metric extraction from LiteLLM's content-free standard payload."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Metric:
    value: int | float
    source_field: str


def _mapping(value: object) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return {str(key): child for key, child in value.items()}
    return {}


def _integer(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, float):
        return int(value) if value >= 0 and value.is_integer() else None
    return None


def _number(value: object) -> int | float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float) and value >= 0 and value == value:
        return value
    return None


def _first_metric(
    candidates: tuple[tuple[str, object], ...], *, integer: bool = True
) -> Metric | None:
    for source_field, raw in candidates:
        value = _integer(raw) if integer else _number(raw)
        if value is not None:
            return Metric(value=value, source_field=source_field)
    return None


def extract_metrics(payload: Mapping[str, object]) -> dict[str, Metric]:
    """Extract supported token and multimodal usage counters with provenance."""

    metadata = _mapping(payload.get("metadata"))
    usage = _mapping(payload.get("usage_object"))
    if not usage:
        usage = _mapping(metadata.get("usage_object"))
    prompt_details = _mapping(usage.get("prompt_tokens_details"))
    completion_details = _mapping(usage.get("completion_tokens_details"))
    usage_metadata = _mapping(usage.get("usage_metadata"))

    candidates: dict[str, tuple[tuple[str, object], ...]] = {
        "input_tokens": (
            ("prompt_tokens", payload.get("prompt_tokens")),
            ("usage_object.prompt_tokens", usage.get("prompt_tokens")),
            ("usage_object.input_tokens", usage.get("input_tokens")),
            (
                "usage_object.usage_metadata.prompt_token_count",
                usage_metadata.get("prompt_token_count"),
            ),
        ),
        "output_tokens": (
            ("completion_tokens", payload.get("completion_tokens")),
            ("usage_object.completion_tokens", usage.get("completion_tokens")),
            ("usage_object.output_tokens", usage.get("output_tokens")),
            (
                "usage_object.usage_metadata.candidates_token_count",
                usage_metadata.get("candidates_token_count"),
            ),
        ),
        "cache_read_input_tokens": (
            (
                "usage_object.prompt_tokens_details.cached_tokens",
                prompt_details.get("cached_tokens"),
            ),
            ("usage_object.cache_read_input_tokens", usage.get("cache_read_input_tokens")),
            (
                "usage_object.cache_read_input_token_count",
                usage.get("cache_read_input_token_count"),
            ),
            (
                "usage_object.usage_metadata.cached_content_token_count",
                usage_metadata.get("cached_content_token_count"),
            ),
        ),
        "cache_write_input_tokens": (
            (
                "usage_object.cache_creation_input_tokens",
                usage.get("cache_creation_input_tokens"),
            ),
            (
                "usage_object.cache_creation_input_token_count",
                usage.get("cache_creation_input_token_count"),
            ),
        ),
        "reasoning_output_tokens": (
            (
                "usage_object.completion_tokens_details.reasoning_tokens",
                completion_details.get("reasoning_tokens"),
            ),
            ("usage_object.reasoning_tokens", usage.get("reasoning_tokens")),
            (
                "usage_object.usage_metadata.thoughts_token_count",
                usage_metadata.get("thoughts_token_count"),
            ),
        ),
        "input_images": (("usage_object.input_images", usage.get("input_images")),),
        "output_images": (("usage_object.output_images", usage.get("output_images")),),
        "audio_input_seconds": (
            ("usage_object.audio_input_seconds", usage.get("audio_input_seconds")),
        ),
        "audio_output_seconds": (
            ("usage_object.audio_output_seconds", usage.get("audio_output_seconds")),
        ),
        "video_input_seconds": (
            ("usage_object.video_input_seconds", usage.get("video_input_seconds")),
            ("usage_object.input_video_seconds", usage.get("input_video_seconds")),
        ),
        "video_output_seconds": (
            ("usage_object.video_output_seconds", usage.get("video_output_seconds")),
            ("usage_object.output_video_seconds", usage.get("output_video_seconds")),
        ),
        "embedding_tokens": (("usage_object.embedding_tokens", usage.get("embedding_tokens")),),
    }
    result: dict[str, Metric] = {}
    duration_metrics = {
        "audio_input_seconds",
        "audio_output_seconds",
        "video_input_seconds",
        "video_output_seconds",
    }
    for name, metric_candidates in candidates.items():
        metric = _first_metric(metric_candidates, integer=name not in duration_metrics)
        if metric is not None:
            result[name] = metric
    return result

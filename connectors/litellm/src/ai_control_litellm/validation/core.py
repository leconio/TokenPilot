"""Shared scalar, timestamp, and structural validation for current contracts."""

from __future__ import annotations

import json
import re
from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic.experimental.missing_sentinel import MISSING

INT64_MAX = 9_223_372_036_854_775_807
INT64_MIN = -9_223_372_036_854_775_808
MAX_DIMENSION_UTF8_BYTES = 8192
RESERVED_DIMENSION_KEYS = {
    "user_id",
    "virtual_model",
    "model",
    "request_model",
    "provider",
    "route_reason",
    "operation_id",
}
EXPECTED_USAGE_UNITS = {
    "uncached_input_token": "token",
    "cache_read_input_token": "token",
    "cache_write_input_token": "token",
    "output_token": "token",
    "reasoning_output_token": "token",
    "input_image": "image",
    "output_image": "image",
    "input_audio_second": "second",
    "output_audio_second": "second",
    "input_video_second": "second",
    "output_video_second": "second",
    "embedding_token": "token",
    "request": "request",
    "unknown": "unknown",
}
RECONCILIATION_COUNT_FIELDS = {
    "event_count",
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "aiu_micros",
    "unpriced_count",
    "unrated_count",
    "diff_count",
}
TIMESTAMP_FIELDS = {
    "acknowledged_at",
    "applied_at",
    "ch_watermark",
    "created_at",
    "event_time",
    "expires_at",
    "finished_at",
    "occurred_at",
    "pg_watermark",
    "published_at",
    "range_end",
    "range_start",
    "resolved_at",
    "sent_at",
    "started_at",
    "watermark",
}
OPAQUE_MAP_FIELDS = {
    "analytics_dimensions",
    "data",
    "dimensions",
    "event_properties",
    "user_properties",
}
UTC_TIMESTAMP_PATTERN = re.compile(
    r"^(?P<year>[0-9]{4})-(?P<month>[0-9]{2})-(?P<day>[0-9]{2})T"
    r"(?P<hour>[0-9]{2}):(?P<minute>[0-9]{2}):(?P<second>[0-9]{2})"
    r"(?:\.(?P<fraction>[0-9]{1,9}))?Z$"
)


def _optional(value: Any) -> Any:
    return None if value is MISSING else value


def _parse_utc_timestamp(value: str) -> tuple[int, int, int, int, int, int, int]:
    match = UTC_TIMESTAMP_PATTERN.fullmatch(value)
    if match is None:
        raise ValueError("expected an RFC3339 UTC timestamp ending in Z")
    year, month, day, hour, minute, second = (
        int(match[name]) for name in ("year", "month", "day", "hour", "minute", "second")
    )
    try:
        datetime(year, month, day, hour, minute, second)
    except ValueError as error:
        raise ValueError("expected a real calendar timestamp") from error
    fraction = int((match["fraction"] or "").ljust(9, "0"))
    return year, month, day, hour, minute, second, fraction


def _validate_real_utc_timestamp(value: str) -> str:
    _parse_utc_timestamp(value)
    return value


def _enum_value(value: StrEnum | str) -> str:
    return value.value if isinstance(value, StrEnum) else value


def _validate_timestamp_order(start: str, end: str, message: str) -> None:
    if _parse_utc_timestamp(start) >= _parse_utc_timestamp(end):
        raise ValueError(message)


def _validate_no_surrogate_code_points(
    value: Any, *, allow_opaque_report_data: bool = False
) -> None:
    def walk(child: Any, *, top_level: bool = False) -> None:
        if isinstance(child, str):
            if any(0xD800 <= ord(character) <= 0xDFFF for character in child):
                raise ValueError("expected Unicode scalar values without surrogate code points")
            return
        if isinstance(child, dict):
            for key, nested in child.items():
                walk(key)
                if not (top_level and allow_opaque_report_data and key == "data"):
                    walk(nested)
            return
        if isinstance(child, (list, tuple)):
            for nested in child:
                walk(nested)

    payload = (
        value.model_dump(mode="python", by_alias=True, exclude_unset=True)
        if hasattr(value, "model_dump")
        else value
    )
    walk(payload, top_level=True)


def _validate_model_timestamps(model: Any, *, allow_opaque_report_data: bool = False) -> None:
    def walk(value: Any) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if key in OPAQUE_MAP_FIELDS or child is MISSING:
                    continue
                if key in TIMESTAMP_FIELDS and child is not None:
                    _validate_real_utc_timestamp(child)
                else:
                    walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    _validate_no_surrogate_code_points(model, allow_opaque_report_data=allow_opaque_report_data)
    walk(model.model_dump(mode="python", by_alias=True, exclude_unset=True))


def _validate_unique(values: list[Any], message: str) -> None:
    serialized = [
        json.dumps(value, separators=(",", ":"), ensure_ascii=False, default=str)
        for value in values
    ]
    if len(serialized) != len(set(serialized)):
        raise ValueError(message)


def _validate_nonnegative_int64(value: str) -> None:
    parsed = int(value)
    if parsed < 0 or parsed > INT64_MAX:
        raise ValueError("expected a non-negative signed-int64 value")


def _validate_signed_int64(value: str) -> None:
    parsed = int(value)
    if parsed < INT64_MIN or parsed > INT64_MAX:
        raise ValueError("expected a signed-int64 value")


def _validate_micro_fields(model: Any, *, signed_fields: set[str] | None = None) -> None:
    signed = signed_fields or set()
    payload = model.model_dump(mode="python", by_alias=True, exclude_unset=True)
    for key, value in payload.items():
        if not key.endswith("_aiu_micros") or value is None:
            continue
        if key in signed:
            _validate_signed_int64(value)
        else:
            _validate_nonnegative_int64(value)


def _validate_dimension_map(value: dict[str, Any]) -> None:
    _validate_no_surrogate_code_points(value)
    for key in value:
        if key.startswith("cp_") or key in RESERVED_DIMENSION_KEYS:
            raise ValueError(f"dimension key {key} is reserved")
    serialized = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    if len(serialized.encode("utf-8")) > MAX_DIMENSION_UTF8_BYTES:
        raise ValueError("expected dimensions to use at most 8192 UTF-8 bytes")

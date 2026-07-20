"""Domain-level semantic validators shared by current contract models."""

from __future__ import annotations

from typing import Any

from .core import (
    EXPECTED_USAGE_UNITS,
    RECONCILIATION_COUNT_FIELDS,
    _enum_value,
    _optional,
    _validate_dimension_map,
    _validate_no_surrogate_code_points,
    _validate_nonnegative_int64,
    _validate_real_utc_timestamp,
    _validate_signed_int64,
    _validate_unique,
)


def _validate_route(route: Any | None) -> None:
    if route is not None:
        _validate_unique(route.tags, "expected unique route tags")


def _validate_usage_result(result: Any) -> None:
    if result.latency_ms is not None and result.latency_ms < 0:
        raise ValueError("latency_ms must be non-negative")


def _validate_usage_line(line: Any) -> str:
    usage_type = _enum_value(line.usage_type)
    unit = _enum_value(line.unit)
    unit_key = _optional(line.unit_key)
    if usage_type == "custom_unit":
        if unit_key is None or unit != "custom":
            raise ValueError("custom_unit requires unit_key and the custom unit")
        return f"custom_unit:{unit_key}"
    if unit_key is not None:
        raise ValueError("unit_key is forbidden for non-custom usage")
    if unit != EXPECTED_USAGE_UNITS[usage_type]:
        raise ValueError(f"{usage_type} has an incompatible unit")
    return usage_type


def _validate_usage_event_semantics(event: Any) -> None:
    _validate_no_surrogate_code_points(event)
    _validate_real_utc_timestamp(event.event_time)
    _validate_route(event.route)
    _validate_dimension_map(event.analytics_dimensions)
    _validate_usage_result(event.result)
    usage_payload = event.usage.model_dump(mode="python", exclude_unset=True)
    custom_units = usage_payload.pop("custom_units", [])
    if not usage_payload and not custom_units:
        raise ValueError("expected at least one usage bucket")
    _validate_unique(
        [unit["unit_key"] for unit in custom_units],
        "expected unique custom unit keys",
    )


def _validate_reconciliation_metrics(value: Any | None, *, signed: bool) -> None:
    if value is None:
        return
    payload = value.model_dump(mode="python", exclude_unset=True)
    if not payload and not signed:
        raise ValueError("expected at least one reconciliation metric")
    for key in RECONCILIATION_COUNT_FIELDS & payload.keys():
        if signed:
            _validate_signed_int64(payload[key])
        else:
            _validate_nonnegative_int64(payload[key])


def _validate_reconciliation_summary(value: Any) -> None:
    payload = value.model_dump(mode="python")
    for key in RECONCILIATION_COUNT_FIELDS & payload.keys():
        _validate_nonnegative_int64(payload[key])

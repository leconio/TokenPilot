"""Content-free structured logging for connector operational signals."""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from datetime import UTC, datetime

LOGGER_NAME = "ai_control_litellm"
SAFE_OPERATIONAL_FIELDS = frozenset(
    {
        "current_bytes",
        "duration_ms",
        "error_code",
        "error_type",
        "event_count",
        "event_id",
        "job_id",
        "maximum_bytes",
        "request_id",
        "status_code",
        "trace_id",
    }
)


def get_logger() -> logging.Logger:
    logger = logging.getLogger(LOGGER_NAME)
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False
    return logger


def log_event(level: int, code: str, fields: Mapping[str, object] | None = None) -> None:
    """Log only caller-selected operational fields; never interpolate exceptions or payloads."""

    record: dict[str, object] = {
        "timestamp": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "level": logging.getLevelName(level).lower(),
        "component": "connector",
        "event": code,
        "request_id": None,
        "event_id": None,
        "job_id": None,
        "trace_id": None,
        "error_code": code if level >= logging.WARNING else None,
        "duration_ms": None,
    }
    if fields is not None:
        record.update(
            {key: value for key, value in fields.items() if key in SAFE_OPERATIONAL_FIELDS}
        )
    get_logger().log(level, json.dumps(record, separators=(",", ":"), sort_keys=True))


def correlation_fields(payload: Mapping[str, object]) -> dict[str, object]:
    """Extract only canonical non-content identifiers from an event payload."""

    fields: dict[str, object] = {}
    event_id = payload.get("event_id")
    request = payload.get("request")
    scope = payload.get("scope")
    if isinstance(event_id, str):
        fields["event_id"] = event_id
    if isinstance(request, Mapping):
        request_id = request.get("request_id")
        if isinstance(request_id, str):
            fields["request_id"] = request_id
        request_trace_id = request.get("trace_id")
        if isinstance(request_trace_id, str):
            fields["trace_id"] = request_trace_id
    if "trace_id" not in fields and isinstance(scope, Mapping):
        trace_id = scope.get("trace_id")
        if isinstance(trace_id, str):
            fields["trace_id"] = trace_id
    return fields

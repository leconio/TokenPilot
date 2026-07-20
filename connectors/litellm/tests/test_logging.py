from __future__ import annotations

import io
import json
import logging

from ai_control_litellm.logging import get_logger, log_event


def test_structured_log_has_fixed_correlation_fields_and_no_content() -> None:
    logger = get_logger()
    original_handlers = list(logger.handlers)
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.handlers = [handler]
    try:
        log_event(
            logging.ERROR,
            "UPLOAD_FAILED",
            {
                "request_id": "request-1",
                "event_id": "event-1",
                "trace_id": "0123456789abcdef0123456789abcdef",
                "error_code": "HTTP_503",
                "authorization": "PROVIDER_KEY_SENTINEL",
                "prompt": "PROMPT_SENTINEL",
            },
        )
    finally:
        logger.handlers = original_handlers

    record = json.loads(stream.getvalue())
    assert record == {
        "component": "connector",
        "duration_ms": None,
        "error_code": "HTTP_503",
        "event": "UPLOAD_FAILED",
        "event_id": "event-1",
        "job_id": None,
        "level": "error",
        "request_id": "request-1",
        "timestamp": record["timestamp"],
        "trace_id": "0123456789abcdef0123456789abcdef",
    }
    assert "PROMPT_SENTINEL" not in stream.getvalue()
    assert "PROVIDER_KEY_SENTINEL" not in stream.getvalue()

from __future__ import annotations

import json
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ai_control_litellm.callback import AiControlLiteLLMCallback
from ai_control_litellm.spool import DurableSpool

from .helpers import connector_config

FIXTURE = Path(__file__).parent / "fixtures" / "current" / "success.json"


def kwargs() -> dict[str, Any]:
    candidate: object = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert isinstance(candidate, dict)
    return candidate


def test_callback_enqueues_content_free_event_locally(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    config = connector_config(path)
    spool = DurableSpool(path, config.max_spool_bytes)
    callback = AiControlLiteLLMCallback(config, spool, autostart=False)
    now = datetime.now(UTC)

    callback.log_success_event(kwargs(), object(), now, now)
    leased = spool.lease(1, 30)

    assert len(leased) == 1
    assert leased[0].payload["schema_version"] == "2.0"
    wire = json.dumps(leased[0].payload)
    assert "PROMPT_MUST_NOT_LEAVE_CALLBACK" not in wire
    assert "RESPONSE_MUST_NOT_LEAVE_CALLBACK" not in wire
    callback.shutdown()


def test_control_plane_outage_never_blocks_model_callback(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    config = connector_config(
        path,
        control_plane_url="http://127.0.0.1:1",
        request_timeout_seconds=0.05,
        flush_interval_seconds=0.01,
    )
    spool = DurableSpool(path, config.max_spool_bytes)
    callback = AiControlLiteLLMCallback(config, spool, autostart=True)

    started = time.perf_counter()
    callback.log_success_event(kwargs(), object(), None, None)
    elapsed = time.perf_counter() - started
    time.sleep(0.05)

    assert elapsed < 0.5
    assert spool.stats().depth == 1
    callback.shutdown()

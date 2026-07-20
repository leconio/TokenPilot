from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import time

import pytest

from ai_control_litellm.spool import (
    CURRENT_SPOOL_FORMAT_REVISION,
    DurableSpool,
    SpoolCapacityError,
    SpoolFormatError,
)

from .helpers import usage_event


def test_enqueue_lease_retry_acknowledge_and_reject(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    first = usage_event(path, "first")
    second = usage_event(path, "second")
    with DurableSpool(path, 20 * 1024 * 1024) as spool:
        assert spool.enqueue(first)
        assert not spool.enqueue(first)
        assert spool.enqueue(second)
        leased = spool.lease(2, 30, now=time.time() + 1)
        assert [row.event_id for row in leased] == [first["event_id"], second["event_id"]]
        spool.retry({leased[0].event_id: 0}, "OFFLINE")
        assert spool.reject([leased[1].event_id], "INVALID_EVENT") == 1
        retried = spool.lease(1, 30, now=time.time() + 2)
        assert retried[0].attempts == 1
        assert spool.acknowledge([retried[0].event_id], "2026-07-15T10:00:00.000Z") == 1
        stats = spool.stats()
        assert stats.depth == 0
        assert stats.rejected == 1
        assert stats.last_successful_upload_at == "2026-07-15T10:00:00.000Z"


def test_restart_recovers_an_unacknowledged_lease_immediately(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    event = usage_event(path)
    spool = DurableSpool(path, 20 * 1024 * 1024)
    spool.enqueue(event)
    assert spool.lease(1, 3600)
    spool.close()

    with DurableSpool(path, 20 * 1024 * 1024) as restarted:
        recovered = restarted.lease(1, 30)
        assert [row.event_id for row in recovered] == [event["event_id"]]


def test_hard_kill_preserves_committed_event(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    event_path = tmp_path / "event.json"
    event_path.write_text(json.dumps(usage_event(path)), encoding="utf-8")
    script = """
import json, os, sys
from pathlib import Path
from ai_control_litellm.spool import DurableSpool
path, event_path = map(Path, sys.argv[1:])
spool = DurableSpool(path, 20 * 1024 * 1024)
spool.enqueue(json.loads(event_path.read_text()))
os._exit(91)
"""
    process = subprocess.run(
        [sys.executable, "-c", script, str(path), str(event_path)], check=False
    )
    assert process.returncode == 91
    with DurableSpool(path, 20 * 1024 * 1024) as spool:
        assert spool.event_ids() == [usage_event(path)["event_id"]]


def test_capacity_error_never_evicts_existing_unacknowledged_event(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    event = usage_event(path)
    with DurableSpool(path, 20 * 1024 * 1024) as spool:
        spool.enqueue(event)
        before = spool.event_ids()
        spool.maximum_bytes = 1
        with pytest.raises(SpoolCapacityError):
            spool.enqueue(usage_event(path, "another"))
        assert spool.event_ids() == before


def test_creates_the_exact_current_format_and_rejects_other_revisions(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    with DurableSpool(path, 20 * 1024 * 1024) as spool:
        assert spool.format_revision == CURRENT_SPOOL_FORMAT_REVISION

    for revision in (0, CURRENT_SPOOL_FORMAT_REVISION + 1):
        connection = sqlite3.connect(path)
        connection.execute(f"PRAGMA user_version={revision}")
        connection.close()
        with pytest.raises(
            SpoolFormatError,
            match=(
                r"Delete .* and restart the Connector.*historical spool migration "
                r"is not supported"
            ),
        ):
            DurableSpool(path, 20 * 1024 * 1024)

        connection = sqlite3.connect(path)
        assert connection.execute("PRAGMA user_version").fetchone()[0] == revision
        connection.close()


def test_rejects_a_non_current_structure_without_patching_it(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE spool_events (event_id TEXT PRIMARY KEY)")
    connection.execute(f"PRAGMA user_version={CURRENT_SPOOL_FORMAT_REVISION}")
    connection.close()

    with pytest.raises(SpoolFormatError, match="table set does not match"):
        DurableSpool(path, 20 * 1024 * 1024)

    connection = sqlite3.connect(path)
    tables = {
        str(row[0])
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        )
    }
    connection.close()
    assert tables == {"spool_events"}

"""Small crash-safe SQLite usage spool shared semantically with the Node SDK."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

FORMAT_REVISION = 1


class UsageSpoolCapacityError(RuntimeError):
    def __init__(self, current_bytes: int, maximum_bytes: int) -> None:
        super().__init__("durable usage spool capacity reached")
        self.current_bytes = current_bytes
        self.maximum_bytes = maximum_bytes


@dataclass(frozen=True, slots=True)
class SpooledUsageEvent:
    event_id: str
    payload: dict[str, object]


class DurableUsageSpool:
    def __init__(self, path: Path, maximum_bytes: int) -> None:
        if maximum_bytes <= 0:
            raise ValueError("usage_spool_max_bytes must be positive")
        self.path = path
        self.maximum_bytes = maximum_bytes
        self._lock = threading.RLock()
        path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(
            path, timeout=10, isolation_level=None, check_same_thread=False
        )
        with self._lock:
            self._connection.execute("PRAGMA busy_timeout=10000")
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA synchronous=FULL")
            revision = int(self._connection.execute("PRAGMA user_version").fetchone()[0])
            if revision not in {0, FORMAT_REVISION}:
                self._connection.close()
                raise RuntimeError(
                    f"usage spool format {revision} is not supported; delete {path} and retry"
                )
            self._connection.executescript(
                f"""
                CREATE TABLE IF NOT EXISTS usage_events (
                    event_id TEXT PRIMARY KEY,
                    payload_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                ) STRICT;
                CREATE INDEX IF NOT EXISTS usage_events_created_idx
                    ON usage_events (created_at, event_id);
                CREATE TABLE IF NOT EXISTS usage_rejected (
                    event_id TEXT PRIMARY KEY,
                    payload_json TEXT NOT NULL,
                    reason_code TEXT NOT NULL,
                    rejected_at INTEGER NOT NULL
                ) STRICT;
                PRAGMA user_version={FORMAT_REVISION};
                """
            )

    def _disk_bytes(self) -> int:
        return sum(
            candidate.stat().st_size
            for suffix in ("", "-wal", "-shm")
            if (candidate := Path(f"{self.path}{suffix}")).exists()
        )

    def enqueue(self, event: Mapping[str, object]) -> bool:
        event_id = event.get("event_id")
        if not isinstance(event_id, str) or not event_id:
            raise ValueError("usage event requires event_id")
        serialized = json.dumps(dict(event), ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            existing = self._connection.execute(
                "SELECT 1 FROM usage_events WHERE event_id = ? UNION ALL "
                "SELECT 1 FROM usage_rejected WHERE event_id = ? LIMIT 1",
                (event_id, event_id),
            ).fetchone()
            if existing is not None:
                return False
            current_bytes = self._disk_bytes()
            if current_bytes + len(serialized.encode()) > self.maximum_bytes:
                raise UsageSpoolCapacityError(current_bytes, self.maximum_bytes)
            cursor = self._connection.execute(
                "INSERT OR IGNORE INTO usage_events (event_id, payload_json, created_at) "
                "VALUES (?, ?, ?)",
                (event_id, serialized, int(time.time() * 1_000)),
            )
            return cursor.rowcount == 1

    def pending(self, limit: int) -> list[SpooledUsageEvent]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT event_id, payload_json FROM usage_events ORDER BY rowid LIMIT ?",
                (limit,),
            ).fetchall()
        return [SpooledUsageEvent(str(row[0]), json.loads(str(row[1]))) for row in rows]

    def acknowledge(self, event_ids: Sequence[str]) -> int:
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                removed = sum(
                    self._connection.execute(
                        "DELETE FROM usage_events WHERE event_id = ?", (event_id,)
                    ).rowcount
                    for event_id in event_ids
                )
                self._connection.execute("COMMIT")
                return removed
            except BaseException:
                self._connection.execute("ROLLBACK")
                raise

    def reject(self, event_id: str, reason_code: str) -> None:
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                self._connection.execute(
                    "INSERT OR IGNORE INTO usage_rejected "
                    "(event_id, payload_json, reason_code, rejected_at) "
                    "SELECT event_id, payload_json, ?, ? FROM usage_events WHERE event_id = ?",
                    (reason_code[:120], int(time.time() * 1_000), event_id),
                )
                self._connection.execute("DELETE FROM usage_events WHERE event_id = ?", (event_id,))
                self._connection.execute("COMMIT")
            except BaseException:
                self._connection.execute("ROLLBACK")
                raise

    @property
    def depth(self) -> int:
        with self._lock:
            return int(self._connection.execute("SELECT COUNT(*) FROM usage_events").fetchone()[0])

    def close(self) -> None:
        with self._lock:
            self._connection.close()

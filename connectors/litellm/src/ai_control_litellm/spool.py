"""Crash-safe SQLite WAL spool for unacknowledged usage events."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from collections.abc import Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path

from .contracts import CanonicalUsageEvent
from .spool_schema import (
    CURRENT_SPOOL_FORMAT_REVISION as CURRENT_SPOOL_FORMAT_REVISION,
)
from .spool_schema import SpoolFormatError as SpoolFormatError
from .spool_schema import create_current_schema, require_current_schema


class SpoolCapacityError(RuntimeError):
    """Raised when admitting another event would exceed the configured disk cap."""

    def __init__(self, current_bytes: int, maximum_bytes: int) -> None:
        super().__init__("durable spool capacity reached")
        self.current_bytes = current_bytes
        self.maximum_bytes = maximum_bytes


@dataclass(frozen=True, slots=True)
class SpoolEvent:
    event_id: str
    payload: dict[str, object]
    attempts: int
    created_at: float


@dataclass(frozen=True, slots=True)
class SpoolStats:
    pending: int
    inflight: int
    rejected: int
    total_bytes: int
    maximum_bytes: int
    oldest_event_age_seconds: float | None
    last_successful_upload_at: str | None

    @property
    def depth(self) -> int:
        return self.pending + self.inflight

    @property
    def capacity_ratio(self) -> float:
        return min(1.0, self.total_bytes / self.maximum_bytes)


class DurableSpool:
    """Single-process SQLite spool; unacknowledged rows are never evicted."""

    def __init__(self, path: Path, maximum_bytes: int) -> None:
        self.path = path
        self.maximum_bytes = maximum_bytes
        self._lock = threading.RLock()
        self._closed = False
        should_create_schema = not path.exists()
        path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(
            str(path), timeout=10.0, isolation_level=None, check_same_thread=False
        )
        self._connection.row_factory = sqlite3.Row
        with self._lock:
            try:
                self._connection.execute("PRAGMA busy_timeout=10000")
                if should_create_schema:
                    self._connection.execute("PRAGMA journal_mode=WAL")
                    self._connection.execute("PRAGMA synchronous=FULL")
                    self._connection.execute("PRAGMA foreign_keys=ON")
                    create_current_schema(self._connection)
                require_current_schema(self._connection, path)
                if not should_create_schema:
                    self._connection.execute("PRAGMA journal_mode=WAL")
                    self._connection.execute("PRAGMA synchronous=FULL")
                    self._connection.execute("PRAGMA foreign_keys=ON")
                # A newly started owner implies the previous owner exited; reclaim all leases now.
                self._connection.execute(
                    "UPDATE spool_events SET state = 'pending', lease_until = NULL "
                    "WHERE state = 'inflight'"
                )
            except BaseException:
                self._connection.close()
                self._closed = True
                raise

    @property
    def format_revision(self) -> int:
        with self._lock:
            self._ensure_open()
            return int(self._connection.execute("PRAGMA user_version").fetchone()[0])

    def __enter__(self) -> DurableSpool:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("spool is closed")

    def _disk_bytes(self) -> int:
        total = 0
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(f"{self.path}{suffix}")
            with suppress(FileNotFoundError):
                total += candidate.stat().st_size
        return total

    def enqueue(self, payload: Mapping[str, object]) -> bool:
        """Validate and durably commit one event; return False for an existing event ID."""

        event_id = str(CanonicalUsageEvent.model_validate(payload).event_id)
        event_dict = dict(payload)
        serialized = json.dumps(event_dict, separators=(",", ":"), sort_keys=True)
        now = time.time()
        with self._lock:
            self._ensure_open()
            existing = self._connection.execute(
                "SELECT 1 FROM spool_events WHERE event_id = ? "
                "UNION ALL SELECT 1 FROM spool_rejected WHERE event_id = ? LIMIT 1",
                (event_id, event_id),
            ).fetchone()
            if existing is not None:
                return False
            current_bytes = self._disk_bytes()
            if current_bytes + len(serialized.encode()) > self.maximum_bytes:
                raise SpoolCapacityError(current_bytes, self.maximum_bytes)
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                cursor = self._connection.execute(
                    """
                    INSERT OR IGNORE INTO spool_events
                        (event_id, payload_json, state, available_at, created_at)
                    VALUES (?, ?, 'pending', ?, ?)
                    """,
                    (event_id, serialized, now, now),
                )
                self._connection.execute("COMMIT")
            except BaseException:
                self._connection.execute("ROLLBACK")
                raise
            return cursor.rowcount == 1

    def lease(self, limit: int, lease_seconds: float, now: float | None = None) -> list[SpoolEvent]:
        """Atomically claim a ready batch; expired leases are recovered first."""

        current = time.time() if now is None else now
        with self._lock:
            self._ensure_open()
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                self._connection.execute(
                    "UPDATE spool_events SET state = 'pending', lease_until = NULL "
                    "WHERE state = 'inflight' AND lease_until <= ?",
                    (current,),
                )
                rows = self._connection.execute(
                    """
                    SELECT event_id, payload_json, attempts, created_at
                    FROM spool_events
                    WHERE state = 'pending' AND available_at <= ?
                    ORDER BY created_at, event_id
                    LIMIT ?
                    """,
                    (current, limit),
                ).fetchall()
                ids = [str(row["event_id"]) for row in rows]
                if ids:
                    placeholders = ",".join("?" for _ in ids)
                    self._connection.execute(
                        f"UPDATE spool_events SET state = 'inflight', lease_until = ? "
                        f"WHERE event_id IN ({placeholders})",
                        (current + lease_seconds, *ids),
                    )
                self._connection.execute("COMMIT")
            except BaseException:
                self._connection.execute("ROLLBACK")
                raise
        return [
            SpoolEvent(
                event_id=str(row["event_id"]),
                payload=json.loads(str(row["payload_json"])),
                attempts=int(row["attempts"]),
                created_at=float(row["created_at"]),
            )
            for row in rows
        ]

    def acknowledge(self, event_ids: Sequence[str], uploaded_at: str | None = None) -> int:
        if not event_ids:
            return 0
        with self._lock:
            self._ensure_open()
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                placeholders = ",".join("?" for _ in event_ids)
                cursor = self._connection.execute(
                    f"DELETE FROM spool_events WHERE event_id IN ({placeholders})",
                    tuple(event_ids),
                )
                if uploaded_at is not None:
                    self._connection.execute(
                        "INSERT INTO spool_state (key, value) VALUES "
                        "('last_successful_upload_at', ?) "
                        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        (uploaded_at,),
                    )
                self._connection.execute("COMMIT")
            except BaseException:
                self._connection.execute("ROLLBACK")
                raise
            return cursor.rowcount

    def retry(
        self,
        retry_at_by_event_id: Mapping[str, float],
        error_code: str,
    ) -> None:
        if not retry_at_by_event_id:
            return
        with self._lock:
            self._ensure_open()
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                for event_id, retry_at in retry_at_by_event_id.items():
                    self._connection.execute(
                        """
                        UPDATE spool_events
                        SET state = 'pending', attempts = attempts + 1,
                            available_at = ?, lease_until = NULL, last_error_code = ?
                        WHERE event_id = ?
                        """,
                        (retry_at, error_code[:120], event_id),
                    )
                self._connection.execute("COMMIT")
            except BaseException:
                self._connection.execute("ROLLBACK")
                raise

    def reject(self, event_ids: Sequence[str], reason_code: str) -> int:
        """Atomically preserve schema-rejected events outside the upload queue."""

        if not event_ids:
            return 0
        now = time.time()
        with self._lock:
            self._ensure_open()
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                moved = 0
                for event_id in event_ids:
                    row = self._connection.execute(
                        "SELECT payload_json FROM spool_events WHERE event_id = ?", (event_id,)
                    ).fetchone()
                    if row is None:
                        continue
                    self._connection.execute(
                        """
                        INSERT INTO spool_rejected
                            (event_id, payload_json, reason_code, rejected_at)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT(event_id) DO NOTHING
                        """,
                        (event_id, str(row["payload_json"]), reason_code[:120], now),
                    )
                    self._connection.execute(
                        "DELETE FROM spool_events WHERE event_id = ?", (event_id,)
                    )
                    moved += 1
                self._connection.execute("COMMIT")
            except BaseException:
                self._connection.execute("ROLLBACK")
                raise
            return moved

    def stats(self, now: float | None = None) -> SpoolStats:
        current = time.time() if now is None else now
        with self._lock:
            self._ensure_open()
            counts = {
                str(row["state"]): int(row["count"])
                for row in self._connection.execute(
                    "SELECT state, COUNT(*) AS count FROM spool_events GROUP BY state"
                ).fetchall()
            }
            rejected = int(
                self._connection.execute("SELECT COUNT(*) FROM spool_rejected").fetchone()[0]
            )
            oldest = self._connection.execute(
                "SELECT MIN(created_at) FROM spool_events"
            ).fetchone()[0]
            last_upload = self._connection.execute(
                "SELECT value FROM spool_state WHERE key = 'last_successful_upload_at'"
            ).fetchone()
            return SpoolStats(
                pending=counts.get("pending", 0),
                inflight=counts.get("inflight", 0),
                rejected=rejected,
                total_bytes=self._disk_bytes(),
                maximum_bytes=self.maximum_bytes,
                oldest_event_age_seconds=(
                    None if oldest is None else max(0.0, current - float(oldest))
                ),
                last_successful_upload_at=None if last_upload is None else str(last_upload[0]),
            )

    def rejected_events(self) -> list[tuple[str, str]]:
        with self._lock:
            self._ensure_open()
            return [
                (str(row["event_id"]), str(row["reason_code"]))
                for row in self._connection.execute(
                    "SELECT event_id, reason_code FROM spool_rejected ORDER BY rejected_at"
                ).fetchall()
            ]

    def event_ids(self) -> list[str]:
        with self._lock:
            self._ensure_open()
            return [
                str(row[0])
                for row in self._connection.execute(
                    "SELECT event_id FROM spool_events ORDER BY created_at, event_id"
                ).fetchall()
            ]

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            self._connection.close()
            self._closed = True

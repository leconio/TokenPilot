"""Exact current SQLite schema contract for the LiteLLM durable spool."""

from __future__ import annotations

import sqlite3
from pathlib import Path

CURRENT_SPOOL_FORMAT_REVISION = 1

_EXPECTED_TABLE_COLUMNS: dict[str, tuple[tuple[str, str, int, str | None, int], ...]] = {
    "spool_events": (
        ("event_id", "TEXT", 0, None, 1),
        ("payload_json", "TEXT", 1, None, 0),
        ("state", "TEXT", 1, None, 0),
        ("attempts", "INTEGER", 1, "0", 0),
        ("available_at", "REAL", 1, None, 0),
        ("lease_until", "REAL", 0, None, 0),
        ("created_at", "REAL", 1, None, 0),
        ("last_error_code", "TEXT", 0, None, 0),
    ),
    "spool_rejected": (
        ("event_id", "TEXT", 0, None, 1),
        ("payload_json", "TEXT", 1, None, 0),
        ("reason_code", "TEXT", 1, None, 0),
        ("rejected_at", "REAL", 1, None, 0),
    ),
    "spool_state": (
        ("key", "TEXT", 0, None, 1),
        ("value", "TEXT", 1, None, 0),
    ),
}

_CURRENT_SCHEMA_SQL = f"""
    BEGIN IMMEDIATE;
    CREATE TABLE spool_events (
        event_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'inflight')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        available_at REAL NOT NULL,
        lease_until REAL,
        created_at REAL NOT NULL,
        last_error_code TEXT
    );
    CREATE INDEX spool_events_ready_idx
        ON spool_events (state, available_at, created_at);
    CREATE TABLE spool_rejected (
        event_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        rejected_at REAL NOT NULL
    );
    CREATE TABLE spool_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    PRAGMA user_version={CURRENT_SPOOL_FORMAT_REVISION};
    COMMIT;
"""


class SpoolFormatError(RuntimeError):
    """Raised when an existing spool is not the exact current development format."""


def create_current_schema(connection: sqlite3.Connection) -> None:
    """Install the one supported schema into a new empty SQLite database."""

    connection.executescript(_CURRENT_SCHEMA_SQL)


def require_current_schema(connection: sqlite3.Connection, path: Path) -> None:
    """Reject any database that is not the exact current schema."""

    problem = _current_schema_problem(connection)
    if problem is not None:
        raise SpoolFormatError(
            f"spool is not the current development schema ({problem}). "
            f"Delete {path} and restart the Connector to recreate it; historical spool migration "
            "is not supported."
        )


def _table_columns(
    connection: sqlite3.Connection, table: str
) -> tuple[tuple[str, str, int, str | None, int], ...]:
    return tuple(
        (
            str(row[1]),
            str(row[2]).upper(),
            int(row[3]),
            None if row[4] is None else str(row[4]),
            int(row[5]),
        )
        for row in connection.execute(f'PRAGMA table_info("{table}")')
    )


def _current_schema_problem(connection: sqlite3.Connection) -> str | None:
    try:
        integrity = str(connection.execute("PRAGMA quick_check").fetchone()[0])
    except sqlite3.DatabaseError as error:
        return f"SQLite quick_check failed: {error}"
    if integrity != "ok":
        return f"SQLite quick_check failed: {integrity}"

    revision = int(connection.execute("PRAGMA user_version").fetchone()[0])
    if revision != CURRENT_SPOOL_FORMAT_REVISION:
        return f"found revision {revision}; expected exact revision {CURRENT_SPOOL_FORMAT_REVISION}"

    tables = {
        str(row[0])
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        )
    }
    if tables != set(_EXPECTED_TABLE_COLUMNS):
        return "table set does not match the current schema"

    for table, expected in _EXPECTED_TABLE_COLUMNS.items():
        if _table_columns(connection, table) != expected:
            return f"table {table} does not match the current schema"

    event_table_row = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'spool_events'"
    ).fetchone()
    event_table_sql = "" if event_table_row is None else str(event_table_row[0])
    if "CHECK (state IN ('pending', 'inflight'))" not in event_table_sql:
        return "table spool_events is missing the current state constraint"
    if "CHECK (attempts >= 0)" not in event_table_sql:
        return "table spool_events is missing the current attempts constraint"

    indexes = {
        str(row[0])
        for row in connection.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'"
        )
    }
    if indexes != {"spool_events_ready_idx"}:
        return "index set does not match the current schema"
    index_columns = tuple(
        str(row[2]) for row in connection.execute("PRAGMA index_info('spool_events_ready_idx')")
    )
    if index_columns != ("state", "available_at", "created_at"):
        return "index spool_events_ready_idx does not match the current schema"
    return None

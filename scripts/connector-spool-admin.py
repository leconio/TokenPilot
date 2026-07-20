#!/usr/bin/env python3
"""Offline/online-safe administration for the LiteLLM Connector SQLite spool."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

CURRENT_SPOOL_FORMAT_REVISION = 1
EXPECTED_TABLE_COLUMNS: dict[str, tuple[tuple[str, str, int, str | None, int], ...]] = {
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


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def connect(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        fail(f"spool does not exist: {path}")
    connection = sqlite3.connect(f"file:{path}?mode=rw", uri=True, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout=10000")
    return connection


def format_revision(connection: sqlite3.Connection) -> int:
    return int(connection.execute("PRAGMA user_version").fetchone()[0])


def table_names(connection: sqlite3.Connection) -> set[str]:
    return {
        str(row[0])
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        )
    }


def table_columns(
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


def fail_non_current(problem: str) -> None:
    fail(
        f"spool is not the current development schema ({problem}); delete it and let the "
        "current Connector recreate it. Historical spool migration is not supported"
    )


def verify_integrity(connection: sqlite3.Connection) -> dict[str, int]:
    try:
        check = str(connection.execute("PRAGMA quick_check").fetchone()[0])
    except sqlite3.DatabaseError as error:
        fail(f"SQLite quick_check failed: {error}")
    if check != "ok":
        fail(f"SQLite quick_check failed: {check}")
    revision = format_revision(connection)
    if revision != CURRENT_SPOOL_FORMAT_REVISION:
        fail_non_current(
            f"found revision {revision}; expected exact revision {CURRENT_SPOOL_FORMAT_REVISION}"
        )
    tables = table_names(connection)
    if tables != set(EXPECTED_TABLE_COLUMNS):
        fail_non_current("table set does not match")
    for table, expected in EXPECTED_TABLE_COLUMNS.items():
        if table_columns(connection, table) != expected:
            fail_non_current(f"table {table} does not match")

    event_table_row = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'spool_events'"
    ).fetchone()
    event_table_sql = "" if event_table_row is None else str(event_table_row[0])
    if "CHECK (state IN ('pending', 'inflight'))" not in event_table_sql:
        fail_non_current("table spool_events is missing the current state constraint")
    if "CHECK (attempts >= 0)" not in event_table_sql:
        fail_non_current(
            "table spool_events is missing the current attempts constraint"
        )

    indexes = {
        str(row[0])
        for row in connection.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'"
        )
    }
    if indexes != {"spool_events_ready_idx"}:
        fail_non_current("index set does not match")
    index_columns = tuple(
        str(row[2])
        for row in connection.execute("PRAGMA index_info('spool_events_ready_idx')")
    )
    if index_columns != ("state", "available_at", "created_at"):
        fail_non_current("index spool_events_ready_idx does not match")

    invalid_states = int(
        connection.execute(
            "SELECT count(*) FROM spool_events WHERE state NOT IN ('pending', 'inflight')"
        ).fetchone()[0]
    )
    if invalid_states:
        fail(f"spool has {invalid_states} invalid event states")
    return {
        "schema_version": revision,
        "pending": int(
            connection.execute(
                "SELECT count(*) FROM spool_events WHERE state = 'pending'"
            ).fetchone()[0]
        ),
        "inflight": int(
            connection.execute(
                "SELECT count(*) FROM spool_events WHERE state = 'inflight'"
            ).fetchone()[0]
        ),
        "rejected": int(
            connection.execute("SELECT count(*) FROM spool_rejected").fetchone()[0]
        ),
    }


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def backup(source_path: Path, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if output_path.exists():
        fail(f"refusing to replace an existing backup: {output_path}")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output_path.name}.", suffix=".tmp", dir=output_path.parent
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        source = connect(source_path)
        destination = sqlite3.connect(temporary_path)
        try:
            source.backup(destination)
            destination.row_factory = sqlite3.Row
            verify_integrity(destination)
        finally:
            destination.close()
            source.close()
        os.chmod(temporary_path, 0o600)
        with temporary_path.open("rb") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary_path, output_path)
        checksum_path = output_path.with_suffix(f"{output_path.suffix}.sha256")
        checksum_path.write_text(
            f"{sha256(output_path)}  {output_path.name}\n", encoding="ascii"
        )
        os.chmod(checksum_path, 0o600)
    finally:
        temporary_path.unlink(missing_ok=True)


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("action", choices=["inspect", "integrity", "backup"])
    value.add_argument("--spool", required=True, type=Path)
    value.add_argument("--output", type=Path)
    return value


def main() -> None:
    arguments = parser().parse_args()
    if arguments.action == "backup":
        if arguments.output is None:
            fail("--output is required for backup")
        connection = connect(arguments.spool)
        verify_integrity(connection)
        connection.close()
        backup(arguments.spool, arguments.output)
        print(f"Spool backup verified: {arguments.output}")
        return
    connection = connect(arguments.spool)
    stats = verify_integrity(connection)
    connection.close()
    print(json.dumps(stats, sort_keys=True))


if __name__ == "__main__":
    main()

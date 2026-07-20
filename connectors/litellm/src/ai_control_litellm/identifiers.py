"""Deterministic event identifiers and time-sortable batch identifiers."""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _encode_ulid(value: int) -> str:
    characters: list[str] = []
    for _ in range(26):
        characters.append(_CROCKFORD[value & 31])
        value >>= 5
    return "".join(reversed(characters))


def stable_event_id(call_id: str) -> str:
    """Generate a deterministic ID so duplicate callback delivery is idempotent."""

    value = int.from_bytes(hashlib.sha256(f"litellm:{call_id}".encode()).digest()[:16])
    return _encode_ulid(value)


def new_ulid(timestamp: datetime | None = None) -> str:
    """Create a ULID without adding a runtime dependency."""

    moment = timestamp or datetime.now(UTC)
    milliseconds = int(moment.timestamp() * 1000) & ((1 << 48) - 1)
    entropy = int.from_bytes(secrets.token_bytes(10))
    return _encode_ulid((milliseconds << 80) | entropy)

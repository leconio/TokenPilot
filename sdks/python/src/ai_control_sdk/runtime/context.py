"""ContextVar-based application-user context propagation."""

from __future__ import annotations

import math
import re
import secrets
import time
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass, field

from .contracts import DimensionMap, PropertyMap

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_PROPERTY_KEY = re.compile(r"^[a-z][a-z0-9._-]{0,127}$")
_UNSAFE_PROPERTY_KEYS = frozenset(
    {"api_key", "authorization", "cookie", "messages", "prompt", "response"}
)


def new_ulid() -> str:
    value = (int(time.time() * 1000) << 80) | secrets.randbits(80)
    characters: list[str] = []
    for _ in range(26):
        characters.append(_CROCKFORD[value & 31])
        value >>= 5
    return "".join(reversed(characters)).lower()


def _identifier(prefix: str) -> str:
    return f"{prefix}_{new_ulid()}"


@dataclass(frozen=True, slots=True)
class AiRuntimeContext:
    user_id: str
    display_user: str | None = None
    application_version: str | None = None
    operation_id: str | None = None
    parent_request_id: str | None = None
    session_id: str | None = None
    conversation_id: str | None = None
    call_source: str | None = None
    event_properties: PropertyMap = field(default_factory=dict)
    user_properties: PropertyMap = field(default_factory=dict)
    analytics_dimensions: DimensionMap = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ResolvedAiRuntimeContext:
    user_id: str
    display_user: str | None
    application_version: str | None
    operation_id: str
    request_id: str
    parent_request_id: str | None
    session_id: str | None
    conversation_id: str | None
    trace_id: str
    call_source: str | None
    event_properties: PropertyMap
    user_properties: PropertyMap
    analytics_dimensions: DimensionMap


_context: ContextVar[ResolvedAiRuntimeContext | None] = ContextVar(
    "tokenpilot_runtime_context", default=None
)


def _bounded(value: str | None, field_name: str, maximum: int) -> str | None:
    if value is None:
        return None
    candidate = value.strip()
    if not candidate or len(candidate) > maximum:
        raise ValueError(f"{field_name} must contain 1-{maximum} characters")
    return candidate


def _properties(value: PropertyMap, field_name: str) -> PropertyMap:
    if len(value) > 64:
        raise ValueError(f"{field_name} supports at most 64 properties")
    output: PropertyMap = {}
    for key, child in value.items():
        if not _PROPERTY_KEY.fullmatch(key) or key in _UNSAFE_PROPERTY_KEYS:
            raise ValueError(f"{field_name}.{key} is not an allowed property key")
        if isinstance(child, str):
            if not child or len(child) > 2_048:
                raise ValueError(f"{field_name}.{key} must contain 1-2048 characters")
        elif isinstance(child, bool):
            pass
        elif isinstance(child, int | float):
            if not math.isfinite(child) or abs(child) > 9_007_199_254_740_991:
                raise ValueError(f"{field_name}.{key} must be a finite safe number")
        elif isinstance(child, list):
            if (
                len(child) > 32
                or len(set(child)) != len(child)
                or any(not item or len(item) > 256 for item in child)
            ):
                raise ValueError(
                    f"{field_name}.{key} must be a unique list of at most 32 short texts"
                )
        else:
            raise ValueError(f"{field_name}.{key} has an unsupported value")
        output[key] = list(child) if isinstance(child, list) else child
    return output


def _resolve(value: AiRuntimeContext) -> ResolvedAiRuntimeContext:
    user_id = _bounded(value.user_id, "user_id", 256)
    if user_id is None:
        raise ValueError("user_id is required")
    return ResolvedAiRuntimeContext(
        user_id=user_id,
        display_user=_bounded(value.display_user, "display_user", 256),
        application_version=_bounded(value.application_version, "application_version", 64),
        operation_id=_bounded(value.operation_id, "operation_id", 256) or _identifier("op"),
        request_id=_identifier("req"),
        parent_request_id=_bounded(value.parent_request_id, "parent_request_id", 256),
        session_id=_bounded(value.session_id, "session_id", 256),
        conversation_id=_bounded(value.conversation_id, "conversation_id", 256),
        trace_id=_identifier("trace"),
        call_source=_bounded(value.call_source, "call_source", 120),
        event_properties=_properties(value.event_properties, "event_properties"),
        user_properties=_properties(value.user_properties, "user_properties"),
        analytics_dimensions=dict(value.analytics_dimensions),
    )


def _reset(token: Token[ResolvedAiRuntimeContext | None]) -> None:
    _context.reset(token)


@contextmanager
def ai_context(value: AiRuntimeContext) -> Iterator[ResolvedAiRuntimeContext]:
    resolved = _resolve(value)
    token = _context.set(resolved)
    try:
        yield resolved
    finally:
        _reset(token)


@asynccontextmanager
async def async_ai_context(value: AiRuntimeContext) -> AsyncIterator[ResolvedAiRuntimeContext]:
    resolved = _resolve(value)
    token = _context.set(resolved)
    try:
        yield resolved
    finally:
        _reset(token)


def current_ai_context() -> ResolvedAiRuntimeContext | None:
    return _context.get()


def require_ai_context() -> ResolvedAiRuntimeContext:
    value = current_ai_context()
    if value is None:
        raise RuntimeError("No AI runtime context is active")
    return value

"""Configuration and credential helpers shared by Runtime clients."""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from urllib.parse import urlparse

from ..errors import AiControlSdkError
from .chat import AsyncCredentialResolver, CredentialResolver, resolve_async_credential
from .contracts import RuntimeCallConnection
from .state import RuntimeFailMode


def normalize_control_plane_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise AiControlSdkError(
            "SDK_INVALID_CONFIGURATION", "Control Plane URL must be absolute HTTP(S)."
        )
    return value.rstrip("/")


def resolve_sync_credential(
    connection: RuntimeCallConnection,
    credentials: Mapping[str, str],
    resolver: CredentialResolver | None,
) -> str:
    reference = connection.credential_ref
    if reference is None:
        return ""
    value = credentials.get(reference)
    if value is None and resolver is not None:
        value = resolver(reference, connection)
    return require_credential(value or os.environ.get(reference), reference, connection)


async def resolve_async_connection_credential(
    connection: RuntimeCallConnection,
    credentials: Mapping[str, str],
    resolver: AsyncCredentialResolver | None,
) -> str:
    reference = connection.credential_ref
    if reference is None:
        return ""
    value = credentials.get(reference)
    if value is None and resolver is not None:
        value = await resolve_async_credential(resolver, reference, connection)
    return require_credential(value or os.environ.get(reference), reference, connection)


def require_credential(
    value: str | None,
    reference: str,
    connection: RuntimeCallConnection,
) -> str:
    if not value:
        raise AiControlSdkError(
            "SDK_CONNECTION_CREDENTIAL_MISSING",
            f"Credential {reference} is not configured for connection {connection.name}.",
        )
    return value


def fail_open_or_raise[T](
    fail_mode: RuntimeFailMode,
    on_error: Callable[[Exception], None],
    error: Exception,
    fallback: T,
) -> T:
    on_error(error)
    if fail_mode == "fail_closed":
        raise error
    return fallback

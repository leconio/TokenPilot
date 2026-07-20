"""Sync and async hard-limit reservation helpers that never block when disabled."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from contextlib import suppress
from typing import Any

from .async_client import AsyncAiRuntimeClient
from .client import AiRuntimeClient
from .contracts import RuntimeUserReservationRequest, SdkReservationResult


def with_aiu_reservation[T](
    *,
    client: AiRuntimeClient,
    reservation: RuntimeUserReservationRequest | Mapping[str, Any],
    operation: Callable[[str | None], T],
    settled_aiu_micros: Callable[[T], str],
) -> tuple[T, SdkReservationResult]:
    result = client.reserve_user_aiu(reservation)
    token = result.token
    try:
        value = operation(None if token is None else token.token)
        if token is not None:
            client.settle_user_aiu_reservation(token, settled_aiu_micros(value))
        return value, result
    except Exception:
        if token is not None:
            with suppress(Exception):
                # The authoritative reservation expires if release cannot reach the server.
                client.release_user_aiu_reservation(token, "model operation failed")
        raise


async def async_with_aiu_reservation[T](
    *,
    client: AsyncAiRuntimeClient,
    reservation: RuntimeUserReservationRequest | Mapping[str, Any],
    operation: Callable[[str | None], Awaitable[T]],
    settled_aiu_micros: Callable[[T], str],
) -> tuple[T, SdkReservationResult]:
    result = await client.reserve_user_aiu(reservation)
    token = result.token
    try:
        value = await operation(None if token is None else token.token)
        if token is not None:
            await client.settle_user_aiu_reservation(token, settled_aiu_micros(value))
        return value, result
    except Exception:
        if token is not None:
            with suppress(Exception):
                await client.release_user_aiu_reservation(token, "model operation failed")
        raise

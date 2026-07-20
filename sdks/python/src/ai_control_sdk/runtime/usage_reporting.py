"""Durable usage delivery shared by synchronous and asynchronous clients."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol

import httpx

from ..errors import AiControlSdkError
from .state import RuntimeState
from .usage_spool import DurableUsageSpool, SpooledUsageEvent


class UsageClient(Protocol):
    usage_spool: DurableUsageSpool | None
    usage_spool_path: Path
    usage_spool_max_bytes: int
    usage_batch_size: int
    state: RuntimeState
    on_error: Callable[[Exception], None]


class SyncUsageClient(UsageClient, Protocol):
    def _request(self, path: str, body: object) -> httpx.Response: ...


class AsyncUsageClient(UsageClient, Protocol):
    async def _request(self, path: str, body: object) -> httpx.Response: ...


def usage_spool(client: UsageClient) -> DurableUsageSpool:
    if client.usage_spool is None:
        client.usage_spool = DurableUsageSpool(
            client.usage_spool_path, client.usage_spool_max_bytes
        )
    return client.usage_spool


def enqueue_usage(client: UsageClient, events: Sequence[Mapping[str, Any]]) -> bool:
    if not events:
        return False
    spool = usage_spool(client)
    for event in events:
        spool.enqueue(event)
    return True


def usage_batch(client: UsageClient, pending: Sequence[SpooledUsageEvent]) -> dict[str, Any]:
    return {
        "schema_version": "2.0",
        "batch_id": pending[0].event_id,
        "sent_at": client.state.now().isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "events": [event.payload for event in pending],
    }


def apply_usage_results(
    client: UsageClient,
    spool: DurableUsageSpool,
    pending: Sequence[SpooledUsageEvent],
    value: object,
) -> int:
    results = value.get("results") if isinstance(value, Mapping) else None
    if not isinstance(results, list):
        raise AiControlSdkError(
            "SDK_USAGE_RESPONSE_INVALID", "Usage upload returned an invalid response."
        )
    delivered = 0
    for item in results:
        if not isinstance(item, Mapping):
            continue
        index = item.get("index")
        event_id = item.get("event_id")
        if not isinstance(event_id, str) and isinstance(index, int) and index < len(pending):
            event_id = pending[index].event_id
        if not isinstance(event_id, str):
            continue
        status = item.get("status")
        if status in {"accepted", "duplicate"}:
            delivered += spool.acknowledge([event_id])
            continue
        code = item.get("code")
        spool.reject(event_id, str(code or status or "REJECTED"))
        client.on_error(
            AiControlSdkError(
                "SDK_USAGE_EVENT_REJECTED",
                str(item.get("message") or f"Usage event {event_id} was rejected."),
            )
        )
    return delivered


def flush_sync_usage(client: SyncUsageClient) -> int:
    spool = usage_spool(client)
    delivered = 0
    while pending := spool.pending(client.usage_batch_size):
        response = client._request("/usage-events/batch", usage_batch(client, pending))
        delivered += apply_usage_results(client, spool, pending, response.json())
    return delivered


async def flush_async_usage(client: AsyncUsageClient) -> int:
    spool = usage_spool(client)
    delivered = 0
    while pending := spool.pending(client.usage_batch_size):
        response = await client._request("/usage-events/batch", usage_batch(client, pending))
        delivered += apply_usage_results(client, spool, pending, response.json())
    return delivered

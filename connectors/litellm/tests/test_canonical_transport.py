from __future__ import annotations

import gzip
import json
import random
import time
from typing import Any

import httpx

from ai_control_litellm.sender import BatchSender, retry_delay_seconds
from ai_control_litellm.spool import DurableSpool

from .helpers import connector_config, usage_event


def response_body(event_ids: list[str], statuses: list[str]) -> dict[str, Any]:
    results = []
    for index, (event_id, status) in enumerate(zip(event_ids, statuses, strict=True)):
        item: dict[str, object] = {"index": index, "event_id": event_id, "status": status}
        if status == "conflict":
            item["code"] = "PAYLOAD_HASH_CONFLICT"
            item["message"] = "immutable event ID has another payload"
        if status == "rejected":
            item["code"] = "INVALID_EVENT"
            item["message"] = "invalid event"
        results.append(item)
    return {
        "schema_version": "2.0",
        "batch_id": "01JQ0000000000000000000000",
        "received_at": "2026-07-16T03:00:00.000Z",
        "accepted": statuses.count("accepted"),
        "duplicates": statuses.count("duplicate"),
        "conflicts": statuses.count("conflict"),
        "rejected": statuses.count("rejected"),
        "results": results,
    }


def test_batch_wrapper_endpoint_gzip_and_acknowledgement(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    first = usage_event(path, "canonical-accepted")
    second = usage_event(path, "canonical-duplicate")
    event_ids = [str(first["event_id"]), str(second["event_id"])]
    observed: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(gzip.decompress(request.content))
        observed.update(
            {
                "path": request.url.path,
                "encoding": request.headers["content-encoding"],
                "body": body,
            }
        )
        response = response_body(event_ids, ["accepted", "duplicate"])
        response["batch_id"] = body["batch_id"]
        return httpx.Response(202, json=response)

    with DurableSpool(path, 20 * 1024 * 1024) as spool:
        spool.enqueue(first)
        spool.enqueue(second)
        client = httpx.Client(transport=httpx.MockTransport(handler))
        result = BatchSender(connector_config(path), spool, client=client).send_once()

        assert result.acknowledged == 2
        assert spool.stats().depth == 0
        assert observed["path"] == "/usage-events/batch"
        assert observed["encoding"] == "gzip"
        body = observed["body"]
        assert isinstance(body, dict)
        assert body["schema_version"] == "2.0"
        assert body["batch_id"]
        assert body["sent_at"].endswith("Z")
        assert [event["schema_version"] for event in body["events"]] == ["2.0", "2.0"]
        client.close()


def test_conflict_and_rejection_are_preserved_not_acknowledged(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    events = [usage_event(path, f"canonical-result-{index}") for index in range(3)]
    event_ids = [str(event["event_id"]) for event in events]

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            202,
            json=response_body(event_ids, ["accepted", "conflict", "rejected"]),
        )

    with DurableSpool(path, 20 * 1024 * 1024) as spool:
        for event in events:
            spool.enqueue(event)
        client = httpx.Client(transport=httpx.MockTransport(handler))
        result = BatchSender(connector_config(path), spool, client=client).send_once()

        assert result.acknowledged == 1
        assert result.rejected == 2
        assert spool.rejected_events() == [
            (event_ids[1], "PAYLOAD_HASH_CONFLICT"),
            (event_ids[2], "INVALID_EVENT"),
        ]
        client.close()


def test_offline_spool_recovers_and_delivers_once(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    event = usage_event(path, "canonical-offline-recovery")
    event_id = str(event["event_id"])
    calls = 0

    def offline(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("control plane offline", request=request)

    def recovered(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        body = json.loads(gzip.decompress(request.content))
        response = response_body([event_id], ["accepted"])
        response["batch_id"] = body["batch_id"]
        return httpx.Response(202, json=response)

    with DurableSpool(path, 20 * 1024 * 1024) as spool:
        spool.enqueue(event)
        offline_client = httpx.Client(transport=httpx.MockTransport(offline))
        first = BatchSender(
            connector_config(path),
            spool,
            client=offline_client,
            random_source=random.Random(1),
        )
        current = time.time() + 1
        assert first.send_once(now=current).outcome == "retry"
        offline_client.close()

        recovered_client = httpx.Client(transport=httpx.MockTransport(recovered))
        second = BatchSender(connector_config(path), spool, client=recovered_client)
        assert second.send_once(now=current + 100).outcome == "acknowledged"
        assert second.send_once(now=current + 101).outcome == "empty"
        assert calls == 1
        assert spool.stats().depth == 0
        recovered_client.close()


def test_spool_restart_recovers_wal_lease(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    event = usage_event(path, "canonical-restart")
    spool = DurableSpool(path, 20 * 1024 * 1024)
    spool.enqueue(event)
    assert spool.lease(1, 3600)
    spool.close()

    with DurableSpool(path, 20 * 1024 * 1024) as restarted:
        recovered = restarted.lease(1, 30)
        assert [item.event_id for item in recovered] == [event["event_id"]]


def test_whole_batch_schema_rejection_is_archived(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    event = usage_event(path, "canonical-batch-rejection")
    with DurableSpool(path, 20 * 1024 * 1024) as spool:
        spool.enqueue(event)
        client = httpx.Client(transport=httpx.MockTransport(lambda _request: httpx.Response(422)))
        result = BatchSender(connector_config(path), spool, client=client).send_once()

        assert result.outcome == "rejected"
        assert spool.rejected_events() == [(event["event_id"], "HTTP_422")]
        client.close()


def test_invalid_accepted_response_retries_without_data_loss(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    event = usage_event(path, "canonical-invalid-response")
    with DurableSpool(path, 20 * 1024 * 1024) as spool:
        spool.enqueue(event)
        client = httpx.Client(
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(202, json={"unexpected": True})
            )
        )
        sender = BatchSender(
            connector_config(path),
            spool,
            client=client,
            random_source=random.Random(2),
        )
        current = time.time() + 1
        assert sender.send_once(now=current).outcome == "retry"
        recovered = spool.lease(1, 30, now=current + 100)
        assert recovered[0].event_id == event["event_id"]
        assert recovered[0].attempts == 1
        client.close()


def test_conflict_http_status_is_retried_until_per_event_disposition_arrives(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    event = usage_event(path, "canonical-http-conflict")
    with DurableSpool(path, 20 * 1024 * 1024) as spool:
        spool.enqueue(event)
        client = httpx.Client(transport=httpx.MockTransport(lambda _request: httpx.Response(409)))
        sender = BatchSender(
            connector_config(path),
            spool,
            client=client,
            random_source=random.Random(3),
        )
        current = time.time() + 1
        assert sender.send_once(now=current).outcome == "retry"
        assert spool.stats().depth == 1
        assert spool.rejected_events() == []
        client.close()


def test_backoff_is_bounded_and_jittered() -> None:
    source = random.Random(11)
    values = [retry_delay_seconds(attempt, 1, 8, source) for attempt in range(1, 8)]
    assert all(0 <= value <= min(8, 2**index) for index, value in enumerate(values))
    assert len(set(values)) == len(values)
    assert 0 <= retry_delay_seconds(100_000, 1, 8, source) <= 8

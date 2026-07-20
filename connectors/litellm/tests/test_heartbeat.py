from __future__ import annotations

import httpx

from ai_control_litellm.heartbeat import HeartbeatReporter
from ai_control_litellm.spool import DurableSpool

from .helpers import connector_config, usage_event


def test_heartbeat_reports_buffer_depth_and_degraded_rejected_state(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    config = connector_config(path)
    with DurableSpool(path, config.max_spool_bytes) as spool:
        event = usage_event(path)
        spool.enqueue(event)
        spool.reject([event["event_id"]], "INVALID_EVENT")
        reporter = HeartbeatReporter(config, spool, client=httpx.Client())
        payload = reporter.payload()
        assert payload["status"] == "degraded"
        assert payload["buffer_depth"] == 0
        assert payload["connector"]["instance_id"] == config.instance_id
        assert payload["capabilities"] == {
            "usage_schema": "2.0",
            "application_users": True,
            "privacy_mode": "content_free",
            "durable_batch_upload": True,
        }
        reporter.stop()


def test_heartbeat_post_uses_control_plane_endpoint(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    observed: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        observed["path"] = request.url.path
        observed["request_id"] = request.headers["x-request-id"]
        observed["usage_schemas"] = request.headers["x-tokenpilot-usage-schemas"]
        observed["privacy_mode"] = request.headers["x-tokenpilot-privacy-mode"]
        observed["payload"] = request.read()
        return httpx.Response(202)

    config = connector_config(path)
    with DurableSpool(path, config.max_spool_bytes) as spool:
        client = httpx.Client(transport=httpx.MockTransport(handler))
        reporter = HeartbeatReporter(config, spool, client=client)
        assert reporter.send_once()
        assert observed["path"] == "/connectors/heartbeat"
        request_id = observed["request_id"]
        payload = observed["payload"]
        assert isinstance(request_id, str)
        assert isinstance(payload, bytes)
        assert request_id in payload.decode()
        assert observed["usage_schemas"] == "2.0"
        assert observed["privacy_mode"] == "content-free"
        reporter.stop()
        client.close()

"""Periodic connector heartbeat reporting durable buffer health."""

from __future__ import annotations

import logging
import threading
from datetime import UTC, datetime
from typing import Any

import httpx

from .config import ConnectorConfig
from .contracts import CanonicalConnectorHeartbeat
from .identifiers import new_ulid
from .logging import log_event
from .spool import DurableSpool


class HeartbeatReporter:
    def __init__(
        self,
        config: ConnectorConfig,
        spool: DurableSpool,
        *,
        client: httpx.Client | None = None,
    ) -> None:
        self.config = config
        self.spool = spool
        self._owns_client = client is None
        self._client = client or httpx.Client(timeout=config.request_timeout_seconds)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def payload(self) -> dict[str, Any]:
        now = datetime.now(UTC)
        stats = self.spool.stats(now.timestamp())
        heartbeat = CanonicalConnectorHeartbeat.model_validate(
            {
                "schema_version": "2.0",
                "heartbeat_id": new_ulid(now),
                "sent_at": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "connector": {
                    "instance_id": self.config.instance_id,
                    "name": "tokenpilot-litellm",
                    "type": "litellm",
                    "version": self.config.connector_version,
                },
                "capabilities": {
                    "usage_schema": self.config.usage_schema_capabilities[0],
                    "application_users": True,
                    "privacy_mode": "content_free",
                    "durable_batch_upload": True,
                },
                "status": "degraded"
                if stats.capacity_ratio >= 0.9 or stats.rejected > 0
                else "healthy",
                "buffer_depth": stats.depth,
                "oldest_event_age_seconds": stats.oldest_event_age_seconds,
                "last_successful_upload_at": stats.last_successful_upload_at,
            }
        )
        return heartbeat.model_dump(mode="json", by_alias=True, exclude_none=False)

    def send_once(self) -> bool:
        if self.config.api_key is None or not self.config.sender_enabled:
            return False
        payload = self.payload()
        heartbeat_id = str(payload["heartbeat_id"])
        try:
            response = self._client.post(
                self.config.heartbeat_url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {self.config.api_key}",
                    "User-Agent": f"tokenpilot-litellm/{self.config.connector_version}",
                    "X-Request-ID": heartbeat_id,
                    "X-TokenPilot-Usage-Schemas": ",".join(self.config.usage_schema_capabilities),
                    "X-TokenPilot-Privacy-Mode": "content-free",
                },
            )
            if 200 <= response.status_code < 300:
                return True
            log_event(
                logging.WARNING,
                "HEARTBEAT_REJECTED",
                {
                    "event_id": heartbeat_id,
                    "error_code": f"HTTP_{response.status_code}",
                    "status_code": response.status_code,
                },
            )
        except httpx.HTTPError as error:
            log_event(
                logging.WARNING,
                "HEARTBEAT_FAILED",
                {
                    "event_id": heartbeat_id,
                    "error_code": type(error).__name__,
                    "error_type": type(error).__name__,
                },
            )
        return False

    def _run(self) -> None:
        while not self._stop.wait(self.config.heartbeat_interval_seconds):
            try:
                self.send_once()
            except Exception as error:
                log_event(
                    logging.ERROR,
                    "HEARTBEAT_LOOP_FAILED",
                    {"error_type": type(error).__name__},
                )

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="tokenpilot-litellm-heartbeat", daemon=True
        )
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
        if self._owns_client:
            self._client.close()

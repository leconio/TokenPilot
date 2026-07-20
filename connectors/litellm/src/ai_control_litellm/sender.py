"""Background batch uploader with gzip, idempotent acknowledgement, and backoff."""

from __future__ import annotations

import gzip
import json
import logging
import random
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx
from pydantic import ValidationError

from .config import ConnectorConfig
from .logging import correlation_fields, log_event
from .spool import DurableSpool, SpoolEvent
from .wire import build_batch, response_dispositions


@dataclass(frozen=True, slots=True)
class UploadResult:
    outcome: str
    leased: int = 0
    acknowledged: int = 0
    rejected: int = 0


def retry_delay_seconds(
    attempt: int,
    base_seconds: float,
    maximum_seconds: float,
    random_source: random.Random,
) -> float:
    """Full-jitter exponential backoff bounded by the configured maximum."""

    exponent = min(60, max(0, attempt - 1))
    ceiling = min(maximum_seconds, base_seconds * (2**exponent))
    return random_source.uniform(0, ceiling)


class BatchSender:
    def __init__(
        self,
        config: ConnectorConfig,
        spool: DurableSpool,
        *,
        client: httpx.Client | None = None,
        random_source: random.Random | None = None,
    ) -> None:
        self.config = config
        self.spool = spool
        self._owns_client = client is None
        self._client = client or httpx.Client(timeout=config.request_timeout_seconds)
        self._random = random_source or random.Random()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="tokenpilot-litellm-sender", daemon=True
        )
        self._thread.start()

    def wake(self) -> None:
        self._wake.set()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                result = self.send_once()
            except Exception as error:
                log_event(
                    logging.ERROR,
                    "SENDER_LOOP_FAILED",
                    {"error_type": type(error).__name__},
                )
                result = UploadResult("internal_error")
            if result.outcome in {"acknowledged", "partial"} and result.leased > 0:
                continue
            self._wake.wait(self.config.flush_interval_seconds)
            self._wake.clear()

    def _retry(self, events: list[SpoolEvent], code: str, now: float) -> UploadResult:
        retry_times = {
            event.event_id: now
            + retry_delay_seconds(
                event.attempts + 1,
                self.config.retry_base_seconds,
                self.config.retry_max_seconds,
                self._random,
            )
            for event in events
        }
        self.spool.retry(retry_times, code)
        log_event(
            logging.WARNING,
            "UPLOAD_RETRY_SCHEDULED",
            {
                "event_count": len(events),
                "error_code": code,
                **correlation_fields(events[0].payload),
            },
        )
        return UploadResult("retry", leased=len(events))

    def send_once(self, now: float | None = None) -> UploadResult:
        current = time.time() if now is None else now
        if self.config.api_key is None or not self.config.sender_enabled:
            return UploadResult("disabled")
        events = self.spool.lease(self.config.batch_size, self.config.lease_seconds, now=current)
        if not events:
            return UploadResult("empty")
        batch_payload = build_batch(events)
        wire = json.dumps(batch_payload, separators=(",", ":"), sort_keys=True).encode()
        compressed = gzip.compress(wire, mtime=0)
        correlation = correlation_fields(events[0].payload)
        try:
            response = self._client.post(
                self.config.ingestion_url,
                content=compressed,
                headers={
                    "Authorization": f"Bearer {self.config.api_key}",
                    "Content-Type": "application/json",
                    "Content-Encoding": "gzip",
                    "Accept": "application/json",
                    "User-Agent": f"tokenpilot-litellm/{self.config.connector_version}",
                    **(
                        {"X-Request-ID": str(correlation["request_id"])}
                        if "request_id" in correlation
                        else {}
                    ),
                },
            )
        except httpx.HTTPError as network_error:
            return self._retry(events, type(network_error).__name__.upper()[:120], current)

        ids = [event.event_id for event in events]
        uploaded_at = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        if response.status_code in {400, 422}:
            rejected = self.spool.reject(ids, f"HTTP_{response.status_code}")
            log_event(
                logging.ERROR,
                "UPLOAD_BATCH_REJECTED",
                {
                    "event_count": rejected,
                    "error_code": f"HTTP_{response.status_code}",
                    **correlation,
                    "status_code": response.status_code,
                },
            )
            return UploadResult("rejected", leased=len(events), rejected=rejected)
        if response.status_code != 202:
            return self._retry(events, f"HTTP_{response.status_code}", current)
        try:
            acknowledged_ids, rejected_items = response_dispositions(
                response.json(), [event.event_id for event in events]
            )
        except (ValidationError, ValueError, json.JSONDecodeError):
            return self._retry(events, "INVALID_BATCH_RESPONSE", current)
        rejected_count = 0
        for event_id, code in rejected_items:
            rejected_count += self.spool.reject([event_id], code)
        acknowledged = self.spool.acknowledge(acknowledged_ids, uploaded_at)
        return UploadResult(
            "partial" if rejected_count else "acknowledged",
            leased=len(events),
            acknowledged=acknowledged,
            rejected=rejected_count,
        )

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
        if self._owns_client:
            self._client.close()

"""Exercise durable offline buffering and idempotent recovery against a real Control Plane."""

from __future__ import annotations

import argparse
import json
import os
import random
import tempfile
import time
from pathlib import Path

import httpx

from ai_control_litellm.config import ConnectorConfig
from ai_control_litellm.mapper import map_standard_payload
from ai_control_litellm.sender import BatchSender
from ai_control_litellm.spool import DurableSpool
from ai_control_litellm.standard_payload import extract_standard_logging_payload


def options() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--url", default=os.environ.get("AI_CONTROL_URL", "http://127.0.0.1:4000")
    )
    parser.add_argument("--spool", type=Path)
    parser.add_argument("--call-id", default="release-connector-recovery-01")
    return parser.parse_args()


def config(url: str, key: str, spool: Path) -> ConnectorConfig:
    return ConnectorConfig(
        control_plane_url=url.rstrip("/"),
        api_key=key,
        instance_id="release-connector-recovery",
        spool_path=spool,
        batch_size=10,
        request_timeout_seconds=0.25,
        retry_base_seconds=0.01,
        retry_max_seconds=0.05,
        lease_seconds=1,
        max_spool_bytes=20 * 1024 * 1024,
        sender_enabled=True,
    )


def event(call_id: str, connector: ConnectorConfig) -> dict[str, object]:
    now = time.time()
    payload = extract_standard_logging_payload(
        {
            "standard_logging_object": {
                "id": call_id,
                "trace_id": "trace-release-connector-recovery",
                "status": "success",
                "model": "openai/fake-openai-fast",
                "model_id": "openai-fast-prod",
                "model_group": "text.fast",
                "custom_llm_provider": "openai",
                "prompt_tokens": 1200,
                "completion_tokens": 300,
                "cache_hit": False,
                "response_cost": "0.00182",
                "startTime": now - 0.2,
                "endTime": now,
                "litellm_version": "1.80.0",
                "metadata": {
                    "feature": "connector-recovery-demo",
                    "end_user_id": "demo-recovery-user",
                    "trace_id": "trace-release-connector-recovery",
                    "business_request_id": "request-release-connector-recovery",
                    "configuration_version": 1,
                    "route_tag": "cp:text.fast:peak",
                    "usage_object": {
                        "prompt_tokens": 1200,
                        "completion_tokens": 300,
                        "prompt_tokens_details": {"cached_tokens": 800},
                        "completion_tokens_details": {"reasoning_tokens": 50},
                    },
                },
            },
            "litellm_params": {"model_info": {"id": "openai-fast-prod"}},
        }
    )
    return map_standard_payload(payload, connector)


def main() -> None:
    parsed = options()
    api_key = os.environ.get("AI_CONTROL_INGEST_API_KEY")
    if api_key is None or len(api_key) < 16:
        raise RuntimeError("AI_CONTROL_INGEST_API_KEY is required")

    temporary: tempfile.TemporaryDirectory[str] | None = None
    if parsed.spool is None:
        temporary = tempfile.TemporaryDirectory(prefix="tokenpilot-connector-recovery-")
        spool_path = Path(temporary.name) / "spool.sqlite3"
    else:
        spool_path = parsed.spool.expanduser().resolve()

    offline = config("http://127.0.0.1:1", api_key, spool_path)
    canonical_event = event(str(parsed.call_id), offline)
    with DurableSpool(spool_path, offline.max_spool_bytes) as spool:
        if not spool.enqueue(canonical_event):
            raise RuntimeError(
                "The recovery event was unexpectedly already in the local spool"
            )
        with httpx.Client(timeout=offline.request_timeout_seconds) as client:
            outcome = BatchSender(
                offline, spool, client=client, random_source=random.Random(7)
            ).send_once()
        if outcome.outcome != "retry" or spool.stats().depth != 1:
            raise RuntimeError(
                "Offline delivery did not preserve the unacknowledged event"
            )

    recovered = config(str(parsed.url), api_key, spool_path)
    with DurableSpool(spool_path, recovered.max_spool_bytes) as spool:
        with httpx.Client(timeout=10) as client:
            sender = BatchSender(recovered, spool, client=client)
            uploaded = sender.send_once(now=time.time() + 60)
            empty = sender.send_once(now=time.time() + 61)
        if uploaded.outcome != "acknowledged" or uploaded.acknowledged != 1:
            raise RuntimeError(f"Recovered upload failed: {uploaded.outcome}")
        if empty.outcome != "empty" or spool.stats().depth != 0:
            raise RuntimeError("The acknowledged event remained in the spool")

    print(
        json.dumps(
            {
                "offline_outcome": outcome.outcome,
                "recovered_outcome": uploaded.outcome,
                "acknowledged": uploaded.acknowledged,
                "second_send": empty.outcome,
                "event_id": canonical_event["event_id"],
            }
        )
    )
    if temporary is not None:
        temporary.cleanup()


if __name__ == "__main__":
    main()

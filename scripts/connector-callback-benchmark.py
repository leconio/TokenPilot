#!/usr/bin/env python3
"""Measure real LiteLLM callback-to-SQLite latency without remote I/O."""

from __future__ import annotations

import argparse
import json
import platform
import statistics
import tempfile
import time
from pathlib import Path

from ai_control_litellm.callback import AiControlLiteLLMCallback
from ai_control_litellm.config import ConnectorConfig
from ai_control_litellm.spool import DurableSpool
from ai_control_litellm.wire import build_batch


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=10_000)
    parser.add_argument("--spool", type=Path)
    parsed = parser.parse_args()
    if parsed.count < 1:
        parser.error("--count must be positive")
    return parsed


def callback_payload(call_id: str) -> dict[str, object]:
    return {
        "standard_logging_object": {
            "id": call_id,
            "litellm_call_id": call_id,
            "trace_id": f"trace-{call_id}",
            "status": "success",
            "model": "openai/fake-openai-fast",
            "model_id": "openai-fast-prod",
            "model_group": "text.fast",
            "prompt_tokens": 1_200,
            "completion_tokens": 300,
            "cache_hit": False,
            "response_cost": "0.00182",
            "startTime": 1_784_107_000.0,
            "endTime": 1_784_107_000.25,
            "litellm_version": "1.80.0",
            "request_tags": ["cp:route:peak"],
            "metadata": {
                "usage_object": {
                    "prompt_tokens": 1_200,
                    "completion_tokens": 300,
                    "prompt_tokens_details": {"cached_tokens": 800},
                    "completion_tokens_details": {"reasoning_tokens": 50},
                },
            },
        },
        "litellm_params": {
            "model_info": {"id": "openai-fast-prod"},
            "metadata": {
                "cp": {
                    "context_version": "current-benchmark-context",
                    "subject_id": "benchmark-user",
                    "operation_id": f"business-{call_id}",
                    "feature": "callback-benchmark",
                    "analytics_dimensions": {"benchmark": True},
                    "request_id": f"request-{call_id}",
                    "trace_id": f"trace-{call_id}",
                }
            },
        },
    }


def percentile(sorted_values: list[float], fraction: float) -> float:
    index = max(
        0, min(len(sorted_values) - 1, round((len(sorted_values) - 1) * fraction))
    )
    return sorted_values[index]


def main() -> None:
    parsed = arguments()
    temporary: tempfile.TemporaryDirectory[str] | None = None
    if parsed.spool is None:
        temporary = tempfile.TemporaryDirectory(prefix="tokenpilot-callback-benchmark-")
        spool_path = Path(temporary.name) / "spool.sqlite3"
    else:
        spool_path = parsed.spool.expanduser().resolve()
        spool_path.parent.mkdir(parents=True, exist_ok=True)

    config = ConnectorConfig(
        control_plane_url="http://127.0.0.1:1",
        api_key=None,
        instance_id="callback-benchmark",
        spool_path=spool_path,
        max_spool_bytes=512 * 1024 * 1024,
        sender_enabled=False,
    )
    spool = DurableSpool(spool_path, config.max_spool_bytes)
    callback = AiControlLiteLLMCallback(config, spool, autostart=False)
    latencies_ms: list[float] = []
    started = time.perf_counter()
    for index in range(parsed.count):
        before = time.perf_counter()
        callback.log_success_event(
            callback_payload(f"benchmark-{index:08d}"), object(), None, None
        )
        latencies_ms.append((time.perf_counter() - before) * 1_000)
    elapsed_seconds = time.perf_counter() - started
    depth = spool.stats().depth
    sample = spool.lease(1, lease_seconds=60)
    if len(sample) != 1:
        raise RuntimeError("expected one canonical event sample")
    canonical_batch = build_batch(sample)
    batch_events = canonical_batch.get("events")
    if (
        not isinstance(batch_events, list)
        or not batch_events
        or not isinstance(batch_events[0], dict)
    ):
        raise RuntimeError("canonical usage batch did not contain an event")
    canonical_event = batch_events[0]
    ingestion_path = config.ingestion_url.removeprefix(config.control_plane_url)
    if (
        canonical_batch["schema_version"] != "2.0"
        or canonical_event["schema_version"] != "2.0"
        or ingestion_path != "/usage-events/batch"
        or "/v" in ingestion_path
    ):
        raise RuntimeError(
            "connector benchmark did not produce the canonical usage contract"
        )
    callback.shutdown()

    if depth != parsed.count:
        raise RuntimeError(f"expected {parsed.count} durable events, found {depth}")
    ordered = sorted(latencies_ms)
    spool_bytes = sum(
        candidate.stat().st_size
        for candidate in [
            spool_path,
            Path(f"{spool_path}-wal"),
            Path(f"{spool_path}-shm"),
        ]
        if candidate.exists()
    )
    report = {
        "schema_version": "current",
        "benchmark": "litellm_callback_to_sqlite",
        "measured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
        },
        "count": parsed.count,
        "elapsed_ms": round(elapsed_seconds * 1_000, 3),
        "callbacks_per_second": round(parsed.count / elapsed_seconds, 3),
        "latency_ms": {
            "mean": round(statistics.fmean(latencies_ms), 6),
            "p50": round(percentile(ordered, 0.50), 6),
            "p95": round(percentile(ordered, 0.95), 6),
            "p99": round(percentile(ordered, 0.99), 6),
            "max": round(ordered[-1], 6),
        },
        "durability": {"spool_depth": depth, "spool_bytes": spool_bytes},
        "contract": {
            "batch_schema_version": canonical_batch["schema_version"],
            "event_schema_version": canonical_event["schema_version"],
            "ingestion_path": ingestion_path,
        },
    }
    print(json.dumps(report, separators=(",", ":")))
    if temporary is not None:
        temporary.cleanup()


if __name__ == "__main__":
    main()

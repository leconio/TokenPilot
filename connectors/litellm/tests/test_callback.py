from __future__ import annotations

import asyncio
import time
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import pytest

import ai_control_litellm
from ai_control_litellm.callback import AiControlLiteLLMCallback
from ai_control_litellm.heartbeat import HeartbeatReporter
from ai_control_litellm.runtime_policy import RuntimePolicyClient
from ai_control_litellm.sender import BatchSender
from ai_control_litellm.spool import DurableSpool

from .helpers import connector_config, standard_kwargs


def test_package_callback_path_resolves_to_initialized_custom_logger() -> None:
    assert isinstance(ai_control_litellm.callback, AiControlLiteLLMCallback)
    assert ai_control_litellm.callback is ai_control_litellm.proxy_handler_instance


def test_sync_and_async_success_failure_callbacks_only_enqueue_locally(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    config = connector_config(path)
    spool = DurableSpool(path, config.max_spool_bytes)
    callback = AiControlLiteLLMCallback(config, spool, autostart=False)
    now = datetime.now(UTC)

    callback.log_success_event(standard_kwargs("sync-success"), object(), now, now)
    callback.log_failure_event(standard_kwargs("sync-failure"), object(), now, now)
    asyncio.run(
        callback.async_log_success_event(standard_kwargs("async-success"), object(), now, now)
    )
    asyncio.run(
        callback.async_log_failure_event(standard_kwargs("async-failure"), object(), now, now)
    )
    assert spool.stats().depth == 4
    callback.shutdown()


def test_callback_failure_never_escapes_to_model_call(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    config = connector_config(path)
    spool = DurableSpool(path, config.max_spool_bytes)
    callback = AiControlLiteLLMCallback(config, spool, autostart=False)
    callback.log_success_event({"messages": ["secret"]}, object(), None, None)
    assert spool.stats().depth == 0
    callback.shutdown()


def test_repeated_sync_async_delivery_is_deduplicated(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    config = connector_config(path)
    spool = DurableSpool(path, config.max_spool_bytes)
    callback = AiControlLiteLLMCallback(config, spool, autostart=False)
    kwargs = standard_kwargs("same-call")
    callback.log_success_event(kwargs, object(), None, None)
    asyncio.run(callback.async_log_success_event(kwargs, object(), None, None))
    assert spool.stats().depth == 1
    callback.shutdown()


def test_router_fallback_attempts_with_one_call_id_are_not_deduplicated(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    config = connector_config(path)
    spool = DurableSpool(path, config.max_spool_bytes)
    callback = AiControlLiteLLMCallback(config, spool, autostart=False)
    primary = standard_kwargs("provider-primary-attempt")
    fallback = deepcopy(primary)
    primary_standard = cast(dict[str, object], primary["standard_logging_object"])
    fallback_standard = cast(dict[str, object], fallback["standard_logging_object"])
    primary_standard["litellm_call_id"] = "shared-router-call"
    primary_standard["status"] = "failure"
    fallback_standard["id"] = "provider-fallback-attempt"
    fallback_standard["litellm_call_id"] = "shared-router-call"

    callback.log_failure_event(primary, object(), None, None)
    callback.log_success_event(fallback, object(), None, None)

    events = spool.lease(10, 30)
    assert len(events) == 2
    attempts = {
        cast(dict[str, object], event.payload["request"])["attempt_id"] for event in events
    }
    assert attempts == {
        "provider-primary-attempt",
        "provider-fallback-attempt",
    }
    callback.shutdown()


def test_control_plane_outage_does_not_delay_model_callback(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    config = connector_config(
        path,
        control_plane_url="http://127.0.0.1:1",
        request_timeout_seconds=0.05,
        flush_interval_seconds=0.01,
    )
    spool = DurableSpool(path, config.max_spool_bytes)
    callback = AiControlLiteLLMCallback(config, spool, autostart=True)
    started = time.perf_counter()
    callback.log_success_event(standard_kwargs("offline-model-call"), object(), None, None)
    callback_elapsed = time.perf_counter() - started
    time.sleep(0.05)
    assert callback_elapsed < 0.5
    assert spool.stats().depth == 1
    callback.shutdown()


def test_required_runtime_configuration_blocks_until_a_trusted_snapshot_is_available(
    tmp_path,
) -> None:
    path = tmp_path / "spool.sqlite3"
    config = connector_config(path, policy_api_key=None, policy_required=True)
    spool = DurableSpool(path, config.max_spool_bytes)
    callback = AiControlLiteLLMCallback(config, spool, autostart=False)
    request = {"model": "text.fast", "metadata": {"feature": "assistant"}}

    with pytest.raises(RuntimeError, match="No trusted Runtime Snapshot"):
        asyncio.run(callback.async_pre_call_hook(object(), object(), request, object()))
    callback.shutdown()


def test_required_pre_call_failure_does_not_initialize_usage_spool(tmp_path) -> None:
    blocked_parent = tmp_path / "not-a-directory"
    blocked_parent.write_text("sentinel", encoding="utf-8")
    config = connector_config(
        blocked_parent / "spool.sqlite3",
        policy_api_key=None,
        policy_required=True,
    )
    callback = AiControlLiteLLMCallback(config, autostart=False)
    request = {"model": "text.fast", "metadata": {"feature": "assistant"}}

    with pytest.raises(RuntimeError, match="No trusted Runtime Snapshot"):
        asyncio.run(callback.async_pre_call_hook(object(), object(), request, object()))
    assert callback._spool is None
    callback.shutdown()


def test_policy_initialization_failure_cannot_bypass_pre_call_enforcement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    callback = AiControlLiteLLMCallback(autostart=False)

    def fail_initialization() -> RuntimePolicyClient:
        raise ValueError("invalid runtime configuration")

    monkeypatch.setattr(callback, "_ensure_policy", fail_initialization)
    with pytest.raises(RuntimeError, match="Runtime policy could not be initialized"):
        asyncio.run(
            callback.async_pre_call_hook(object(), object(), {"model": "text.fast"}, object())
        )
    callback.shutdown()


def test_optional_policy_mode_can_bypass_initialization_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = connector_config(
        tmp_path / "spool.sqlite3", policy_api_key=None, policy_required=False
    )
    callback = AiControlLiteLLMCallback(config, autostart=False)
    request = {"model": "text.fast"}

    def fail_initialization() -> RuntimePolicyClient:
        raise ValueError("invalid optional runtime configuration")

    monkeypatch.setattr(callback, "_ensure_policy", fail_initialization)
    assert (
        asyncio.run(callback.async_pre_call_hook(object(), object(), request, object())) == request
    )
    callback.shutdown()


def test_pre_call_starts_policy_lifecycle_only_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "spool.sqlite3"
    config = connector_config(path, policy_api_key=None, policy_required=False)
    policy = RuntimePolicyClient(config)
    starts = 0

    def start_once() -> None:
        nonlocal starts
        starts += 1

    monkeypatch.setattr(policy, "start", start_once)
    callback = AiControlLiteLLMCallback(config, policy=policy, autostart=True)
    request = {"model": "text.fast"}

    assert (
        asyncio.run(callback.async_pre_call_hook(object(), object(), request, object())) == request
    )
    assert (
        asyncio.run(callback.async_pre_call_hook(object(), object(), request, object())) == request
    )
    assert starts == 1
    callback.shutdown()


def test_autostart_workers_use_only_their_own_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    started: list[str] = []

    def start_policy(policy: RuntimePolicyClient) -> None:
        if policy.config.policy_api_key is not None:
            started.append("policy")

    monkeypatch.setattr(RuntimePolicyClient, "start", start_policy)
    monkeypatch.setattr(BatchSender, "start", lambda sender: started.append("sender"))
    monkeypatch.setattr(
        HeartbeatReporter,
        "start",
        lambda heartbeat: started.append("heartbeat"),
    )

    policy_only = AiControlLiteLLMCallback(
        connector_config(
            tmp_path / "policy-spool.sqlite3",
            api_key=None,
            policy_api_key="policy-key-do-not-log",
        ),
        autostart=True,
    )
    policy_only._ensure_runtime()
    assert started == ["policy"]
    policy_only.shutdown()

    started.clear()
    ingestion_only = AiControlLiteLLMCallback(
        connector_config(
            tmp_path / "ingestion-spool.sqlite3",
            api_key="ingestion-key-do-not-log",
            policy_api_key=None,
        ),
        autostart=True,
    )
    ingestion_only._ensure_runtime()
    assert started == ["sender", "heartbeat"]
    ingestion_only.shutdown()


def test_ten_thousand_callbacks_have_bounded_local_overhead(tmp_path) -> None:
    path = tmp_path / "spool.sqlite3"
    config = connector_config(path, max_spool_bytes=100 * 1024 * 1024)
    spool = DurableSpool(path, config.max_spool_bytes)
    callback = AiControlLiteLLMCallback(config, spool, autostart=False)
    started = time.perf_counter()
    for index in range(10_000):
        callback.log_success_event(standard_kwargs(f"stress-{index}"), object(), None, None)
    elapsed = time.perf_counter() - started
    assert spool.stats().depth == 10_000
    average_callback_ms = elapsed * 1_000 / 10_000
    # FULL SQLite durability includes a real fsync for every callback, so aggregate
    # wall time varies materially by storage class. Bound model-path overhead per
    # callback; the release benchmark separately records p50/p95/p99 and throughput.
    assert average_callback_ms < 5
    callback.shutdown()

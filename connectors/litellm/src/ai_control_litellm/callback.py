"""LiteLLM success/failure callback backed by a local durable spool."""

from __future__ import annotations

import atexit
import logging
import threading
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from litellm.integrations.custom_logger import CustomLogger

from .config import ConnectorConfig
from .heartbeat import HeartbeatReporter
from .logging import correlation_fields, log_event
from .mapper import map_standard_payload
from .quota import UserQuotaClient
from .runtime_policy import RuntimePolicyClient
from .sender import BatchSender
from .spool import DurableSpool, SpoolCapacityError
from .standard_payload import extract_standard_logging_payload


class AiControlLiteLLMCallback(CustomLogger):
    """Capture only privacy-safe usage fields and never perform remote I/O in a hook."""

    def __init__(
        self,
        config: ConnectorConfig | None = None,
        spool: DurableSpool | None = None,
        policy: RuntimePolicyClient | None = None,
        quota: UserQuotaClient | None = None,
        *,
        autostart: bool = True,
    ) -> None:
        super().__init__()
        self._config = config
        self._spool = spool
        self._sender: BatchSender | None = None
        self._heartbeat: HeartbeatReporter | None = None
        self._policy = policy
        self._quota = quota
        self._policy_started = False
        self._autostart = autostart
        self._runtime_lock = threading.Lock()

    def _ensure_policy(self) -> RuntimePolicyClient:
        if self._policy is not None and (not self._autostart or self._policy_started):
            return self._policy
        with self._runtime_lock:
            config = self._config or ConnectorConfig.from_environment()
            policy = self._policy or RuntimePolicyClient(config)
            self._config = config
            self._policy = policy
            if self._autostart and not self._policy_started:
                policy.start()
                self._policy_started = True
            return policy

    def _ensure_runtime(self) -> tuple[ConnectorConfig, DurableSpool, BatchSender]:
        if self._config is not None and self._spool is not None and self._sender is not None:
            return self._config, self._spool, self._sender
        with self._runtime_lock:
            config = self._config or ConnectorConfig.from_environment()
            spool = self._spool or DurableSpool(config.spool_path, config.max_spool_bytes)
            sender = self._sender or BatchSender(config, spool)
            heartbeat = self._heartbeat or HeartbeatReporter(config, spool)
            policy = self._policy or RuntimePolicyClient(config)
            self._config = config
            self._spool = spool
            self._sender = sender
            self._heartbeat = heartbeat
            self._policy = policy
            if self._autostart:
                if not self._policy_started:
                    policy.start()
                    self._policy_started = True
                if config.api_key is not None and config.sender_enabled:
                    sender.start()
                    heartbeat.start()
            return config, spool, sender

    async def async_pre_call_hook(
        self,
        user_api_key_dict: object,
        cache: object,
        data: dict[str, Any],
        call_type: object,
    ) -> dict[str, object]:
        del user_api_key_dict, cache, call_type
        try:
            policy = self._ensure_policy()
        except Exception as error:
            log_event(
                logging.ERROR,
                "RUNTIME_POLICY_INITIALIZATION_FAILED",
                {"error_type": type(error).__name__},
            )
            if self._config is not None and not self._config.policy_required:
                return dict(data)
            raise RuntimeError("Runtime policy could not be initialized") from error
        routed = policy.apply_to_request(data)
        config = self._config or ConnectorConfig.from_environment()
        self._config = config
        quota = self._quota or UserQuotaClient(config)
        self._quota = quota
        return await quota.apply_to_request(routed)

    def _capture(
        self,
        kwargs: Mapping[str, object],
        end_time: object,
        status: str,
    ) -> None:
        event: dict[str, Any] | None = None
        try:
            config, spool, sender = self._ensure_runtime()
            standard = extract_standard_logging_payload(kwargs)
            event = map_standard_payload(
                standard,
                config,
                callback_end_time=end_time if isinstance(end_time, datetime) else None,
                callback_status=status,
            )
            inserted = spool.enqueue(event)
            if inserted:
                sender.wake()
        except SpoolCapacityError as error:
            log_event(
                logging.CRITICAL,
                "SPOOL_CAPACITY_REACHED",
                {
                    "current_bytes": error.current_bytes,
                    "maximum_bytes": error.maximum_bytes,
                    **({} if event is None else correlation_fields(event)),
                },
            )
        except Exception as error:
            # Callback failures are operational signals only and must never change model responses.
            log_event(
                logging.ERROR,
                "CALLBACK_CAPTURE_FAILED",
                {
                    "error_type": type(error).__name__,
                    "error_code": type(error).__name__,
                    **({} if event is None else correlation_fields(event)),
                },
            )

    def log_success_event(
        self,
        kwargs: dict[str, Any],
        response_obj: Any,
        start_time: Any,
        end_time: Any,
    ) -> None:
        del response_obj, start_time
        self._capture(kwargs, end_time, "success")

    def log_failure_event(
        self,
        kwargs: dict[str, Any],
        response_obj: Any,
        start_time: Any,
        end_time: Any,
    ) -> None:
        del response_obj, start_time
        self._capture(kwargs, end_time, "failure")

    async def async_log_success_event(
        self,
        kwargs: dict[str, Any],
        response_obj: Any,
        start_time: Any,
        end_time: Any,
    ) -> None:
        del response_obj, start_time
        self._capture(kwargs, end_time, "success")

    async def async_log_failure_event(
        self,
        kwargs: dict[str, Any],
        response_obj: Any,
        start_time: Any,
        end_time: Any,
    ) -> None:
        del response_obj, start_time
        self._capture(kwargs, end_time, "failure")

    def shutdown(self) -> None:
        with self._runtime_lock:
            if self._heartbeat is not None:
                self._heartbeat.stop()
            if self._policy is not None:
                self._policy.stop()
            if self._sender is not None:
                self._sender.stop()
            if self._spool is not None:
                self._spool.close()
            self._heartbeat = None
            self._policy = None
            self._policy_started = False
            self._sender = None
            self._spool = None


# LiteLLM Proxy resolves dotted callback paths to an initialized logger instance.
proxy_handler_instance = AiControlLiteLLMCallback()
custom_handler = proxy_handler_instance
atexit.register(proxy_handler_instance.shutdown)

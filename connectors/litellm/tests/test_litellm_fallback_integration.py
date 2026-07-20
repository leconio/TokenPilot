from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
import litellm
from litellm import Router
from litellm.integrations.custom_logger import CustomLogger

from ai_control_litellm.mapper import map_standard_payload
from ai_control_litellm.standard_payload import extract_standard_logging_payload

from .helpers import connector_config


def available_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


class MappingSpy(CustomLogger):
    def __init__(self, spool_path: Path) -> None:
        super().__init__()
        self.events: list[dict[str, Any]] = []
        self.config = connector_config(spool_path)

    def capture(self, kwargs: dict[str, Any], end_time: object, status: str) -> None:
        standard = extract_standard_logging_payload(kwargs)
        self.events.append(
            map_standard_payload(
                standard,
                self.config,
                callback_end_time=end_time if isinstance(end_time, datetime) else None,
                callback_status=status,
            )
        )

    def log_success_event(self, kwargs, response_obj, start_time, end_time) -> None:
        del response_obj, start_time
        self.capture(kwargs, end_time, "success")

    def log_failure_event(self, kwargs, response_obj, start_time, end_time) -> None:
        del response_obj, start_time
        self.capture(kwargs, end_time, "failure")

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time) -> None:
        self.log_success_event(kwargs, response_obj, start_time, end_time)

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time) -> None:
        self.log_failure_event(kwargs, response_obj, start_time, end_time)


def test_real_litellm_router_fallback_maps_two_correlated_attempts(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    root = Path(__file__).resolve().parents[3]
    port = available_port()
    environment = {
        **os.environ,
        "FAKE_PROVIDER_HOST": "127.0.0.1",
        "FAKE_PROVIDER_PORT": str(port),
        "FAKE_PROVIDER_FAIL_MODELS": "fake-openai-primary",
    }
    provider = subprocess.Popen(
        ["node", "examples/fake-provider/server.mjs"],
        cwd=root,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(50):
            try:
                if httpx.get(f"http://127.0.0.1:{port}/health", timeout=0.2).is_success:
                    break
            except httpx.HTTPError:
                pass
            time.sleep(0.05)
        else:
            raise AssertionError("fake Provider did not become healthy")

        spy = MappingSpy(tmp_path / "unused-spool.sqlite3")
        monkeypatch.setattr(litellm, "callbacks", [spy])
        monkeypatch.setattr(litellm, "success_callback", [spy])
        monkeypatch.setattr(litellm, "failure_callback", [spy])
        router = Router(
            model_list=[
                {
                    "model_name": "text.fast.demo-primary",
                    "litellm_params": {
                        "model": "openai/fake-openai-primary",
                        "api_base": f"http://127.0.0.1:{port}/v1",
                        "api_key": "demo-not-a-provider-credential",
                    },
                    "model_info": {"id": "openai-fast-prod"},
                },
                {
                    "model_name": "text.fast.demo-fallback",
                    "litellm_params": {
                        "model": "openai/fake-gemini-fallback",
                        "api_base": f"http://127.0.0.1:{port}/v1",
                        "api_key": "demo-not-a-provider-credential",
                    },
                    "model_info": {"id": "gemini-fast-prod"},
                },
            ],
            fallbacks=[{"text.fast.demo-primary": ["text.fast.demo-fallback"]}],
            num_retries=0,
        )

        async def execute() -> Any:
            response = await router.acompletion(
                model="text.fast.demo-primary",
                messages=[{"role": "user", "content": "PRIVATE_TEST_PROMPT"}],
                metadata={
                    "tags": ["cp:route:fallback-demo"],
                    "cp": {
                        "context_version": "runtime-current",
                        "user_id": "fallback-user",
                        "display_user": "Fallback user",
                        "operation_id": "fallback-operation",
                        "request_id": "fallback-business-request",
                        "trace_id": "fallback-trace",
                        "call_source": "release-demo",
                    },
                },
            )
            for _ in range(40):
                if len(spy.events) == 2:
                    break
                await asyncio.sleep(0.05)
            return response

        response = asyncio.run(execute())
        assert response.model == "fake-gemini-fallback"
        assert len(spy.events) == 2
        primary = next(event for event in spy.events if event["result"]["status"] == "failure")
        fallback = next(event for event in spy.events if event["result"]["status"] == "success")
        assert primary["model"]["model_id"] is None
        assert primary["result"]["http_status"] == 503
        assert primary["route"]["fallback_from"] is None
        assert primary["usage"] == {
            "uncached_input_tokens": "0",
            "output_tokens": "0",
            "request_count": "1",
        }
        assert fallback["model"]["model_id"] is None
        assert fallback["result"]["http_status"] == 200
        assert fallback["route"]["fallback_from"] == "openai-fast-prod"
        assert fallback["usage"] == {
            "uncached_input_tokens": "400",
            "cache_read_input_tokens": "800",
            "output_tokens": "250",
            "reasoning_output_tokens": "50",
            "request_count": "1",
        }
        for event in spy.events:
            assert event["request"]["request_id"] == "fallback-business-request"
            assert event["request"]["operation_id"] == "fallback-operation"
            assert event["request"]["trace_id"] == "fallback-trace"
            assert event["model"]["virtual_model"].startswith("text.fast")
            assert event["route"]["tags"] == ["cp:route:fallback-demo"]
            assert event["user"]["user_id"] == "fallback-user"
            assert "PRIVATE_TEST_PROMPT" not in json.dumps(event)
        assert primary["request"]["attempt_id"] != fallback["request"]["attempt_id"]
        assert primary["event_id"] != fallback["event_id"]
    finally:
        provider.terminate()
        try:
            provider.wait(timeout=2)
        except subprocess.TimeoutExpired:
            provider.kill()
            provider.wait(timeout=2)

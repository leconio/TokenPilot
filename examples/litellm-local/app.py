"""Run real LiteLLM calls and let the TokenPilot Connector report every attempt."""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import litellm
from ai_control_litellm import AiControlLiteLLMCallback
from dotenv import load_dotenv
from litellm import Router

from fake_provider import create_server


def identifier(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def call_metadata(operation_id: str, request_id: str, action: str) -> dict[str, object]:
    return {
        "tags": ["cp:example:litellm-local"],
        "cp": {
            "context_version": "litellm-local-example",
            "operation_id": operation_id,
            "request_id": request_id,
            "conversation_id": operation_id,
            "trace_id": identifier("trace"),
            "user_id": "local-example-user",
            "display_user": "Mac 本地示例用户",
            "application_version": "local-example-1.0.0",
            "sdk_version": "0.2.0",
            "virtual_model": "local.chat",
            "event_properties": {
                "next_action": action,
                "voice_enabled": False,
            },
            "user_properties": {
                "parse_context": "native-mac",
                "voice_type": "text",
            },
        },
    }


def environment_flag(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be true or false")


def model_entry(alias: str, request_model: str, api_base: str | None, api_key: str | None) -> dict:
    parameters: dict[str, object] = {"model": request_model}
    if api_base:
        parameters["api_base"] = api_base
    if api_key:
        parameters["api_key"] = api_key
    return {
        "model_name": alias,
        "litellm_params": parameters,
        "model_info": {"id": alias},
    }


def router(api_base: str | None, api_key: str | None) -> Router:
    return Router(
        model_list=[
            model_entry(
                "local.success",
                os.getenv("LITELLM_SUCCESS_MODEL", "openai/local-success"),
                api_base,
                api_key,
            ),
            model_entry(
                "local.primary",
                os.getenv("LITELLM_PRIMARY_MODEL", "openai/local-primary"),
                api_base,
                api_key,
            ),
            model_entry(
                "local.fallback",
                os.getenv("LITELLM_FALLBACK_MODEL", "openai/local-fallback"),
                api_base,
                api_key,
            ),
        ],
        fallbacks=[{"local.primary": ["local.fallback"]}],
        num_retries=0,
    )


async def run_calls(client: Router) -> dict[str, Any]:
    started_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    operations = {
        "success": identifier("op"),
        "fallback": identifier("op"),
    }
    await client.acompletion(
        model="local.success",
        messages=[{"role": "user", "content": "This content must never be reported."}],
        metadata=call_metadata(operations["success"], identifier("req"), "summarize"),
    )
    fallback_response = await client.acompletion(
        model="local.primary",
        messages=[{"role": "user", "content": "This content must never be reported."}],
        metadata=call_metadata(operations["fallback"], identifier("req"), "fallback"),
    )
    return {
        "started_at": started_at,
        "operations": operations,
        "user_id": "local-example-user",
        "fallback_model": fallback_response.model,
    }


def main() -> None:
    load_dotenv()
    os.environ.setdefault("NO_PROXY", "127.0.0.1,localhost")
    os.environ.setdefault("no_proxy", os.environ["NO_PROXY"])
    fake = None
    callback = AiControlLiteLLMCallback()
    try:
        api_base = os.getenv("LITELLM_API_BASE")
        api_key = os.getenv("LITELLM_API_KEY")
        if environment_flag("TOKENPILOT_USE_FAKE_PROVIDER", True):
            fake = create_server()
            threading.Thread(
                target=fake.serve_forever, name="local-fake-model", daemon=True
            ).start()
            host, port = fake.server_address
            api_base = f"http://{host}:{port}/v1"
            api_key = api_key or "local-only"
        litellm.callbacks = [callback]
        litellm.success_callback = [callback]
        litellm.failure_callback = [callback]
        evidence = asyncio.run(run_calls(router(api_base, api_key)))
        time.sleep(float(os.getenv("TOKENPILOT_REPORT_WAIT_SECONDS", "2")))
        run_evidence = Path(
            os.getenv("TOKENPILOT_RUN_EVIDENCE", ".tokenpilot/litellm-local-run.json")
        ).expanduser()
        run_evidence.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        run_evidence.write_text(
            json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        run_evidence.chmod(0o600)
        print(json.dumps(evidence, ensure_ascii=False))
    finally:
        callback.shutdown()
        if fake is not None:
            fake.shutdown()
            fake.server_close()


if __name__ == "__main__":
    main()

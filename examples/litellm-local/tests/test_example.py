from __future__ import annotations

import json
import sys
import threading
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import call_metadata, environment_flag, model_entry
from fake_provider import create_server


def test_fake_provider_exercises_success_and_failure_without_logging_content() -> None:
    server = create_server()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address
    try:
        base = f"http://{host}:{port}"
        assert httpx.get(f"{base}/health").is_success
        success = httpx.post(
            f"{base}/v1/chat/completions",
            json={"model": "local-success", "messages": [{"content": "secret"}]},
        )
        failure = httpx.post(
            f"{base}/v1/chat/completions",
            json={"model": "local-primary", "messages": [{"content": "secret"}]},
        )
        assert success.status_code == 200
        assert success.json()["usage"]["prompt_tokens_details"]["cached_tokens"] == 40
        assert failure.status_code == 503
        assert "secret" not in json.dumps(success.json())
        assert "secret" not in json.dumps(failure.json())
    finally:
        server.shutdown()
        server.server_close()


def test_example_reports_required_user_and_typed_fields() -> None:
    metadata = call_metadata("op_test", "req_test", "summarize")
    cp = metadata["cp"]
    assert isinstance(cp, dict)
    assert cp["user_id"] == "local-example-user"
    assert cp["display_user"] == "Mac 本地示例用户"
    assert cp["event_properties"] == {"next_action": "summarize", "voice_enabled": False}
    assert cp["user_properties"] == {"parse_context": "native-mac", "voice_type": "text"}


def test_real_provider_configuration_keeps_native_litellm_model_tags(monkeypatch) -> None:
    monkeypatch.setenv("TOKENPILOT_USE_FAKE_PROVIDER", "false")
    assert environment_flag("TOKENPILOT_USE_FAKE_PROVIDER", True) is False
    entry = model_entry("local.primary", "anthropic/claude-sonnet-4-5", None, None)
    assert entry["litellm_params"] == {"model": "anthropic/claude-sonnet-4-5"}

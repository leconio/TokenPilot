from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from ai_control_litellm import runtime_policy as runtime_policy_module
from ai_control_litellm.runtime_policy import RuntimePolicyClient

from .helpers import connector_config
from .test_runtime_policy import runtime_snapshot, sign_snapshot


def test_lkg_write_failure_is_rejected_without_replacing_active_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    active = runtime_snapshot()
    candidate = runtime_snapshot()
    candidate["version"] = "runtime-policy-2"
    candidate["routing"]["text.fast"]["configuration_version"] = 18
    candidate["routing"]["text.fast"]["configuration_etag"] = f"sha256:{'8' * 64}"
    candidate["routing"]["text.fast"]["default"]["targets"][0]["request_model"] = (
        "litellm-new-primary"
    )
    candidate.pop("etag")
    candidate = sign_snapshot(candidate)
    served = active
    acknowledgement_states: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/runtime/snapshot":
            return httpx.Response(200, json=served)
        if request.url.path == "/runtime/configuration-acknowledgements":
            acknowledgement_states.append(str(json.loads(request.content)["state"]))
            return httpx.Response(202, json={"status": "accepted", "duplicate": False})
        raise AssertionError(f"unexpected request: {request.url}")

    config = connector_config(
        tmp_path / "spool.sqlite3",
        policy_lkg_path=tmp_path / "runtime.json",
    )
    policy = RuntimePolicyClient(config)
    policy._client.close()
    policy._client = httpx.Client(transport=httpx.MockTransport(handler))
    assert policy.refresh_once() == "updated"

    served = candidate

    def reject_write(path: Path, snapshot: object, policy_api_key: str | None) -> None:
        del path, snapshot, policy_api_key
        raise OSError("simulated LKG write failure")

    monkeypatch.setattr(runtime_policy_module, "_atomic_write", reject_write)
    with pytest.raises(OSError, match="simulated LKG write failure"):
        policy.refresh_once()

    assert acknowledgement_states == ["received", "applied", "received", "rejected"]
    assert policy.select_route("text.fast").primary["request_model"] == "litellm-primary"
    persisted = json.loads(config.policy_lkg_path.read_text(encoding="utf-8"))
    assert persisted["snapshot"]["version"] == "runtime-policy-1"
    policy.stop()

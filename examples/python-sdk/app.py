"""Minimal trusted Python Runtime client; model content never enters the Control Plane."""

from __future__ import annotations

import json
import os

from ai_control_sdk import (
    AiRuntimeClient,
    AiRuntimeContext,
    ai_context,
    apply_ai_context_to_openai_request,
)


def required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def main() -> None:
    lkg_path = os.environ.get(
        "AI_CONTROL_LKG_PATH", ".tokenpilot/python-runtime-snapshot.json"
    )
    client = AiRuntimeClient(
        control_plane_url=os.environ.get("AI_CONTROL_URL", "http://127.0.0.1:4000"),
        api_key=required_environment("AI_CONTROL_POLICY_API_KEY"),
        lkg_path=lkg_path,
    )
    try:
        refresh = client.refresh()
        with ai_context(
            AiRuntimeContext(
                user_id="example-user",
                display_user="Example User",
                operation_id="example-operation",
                call_source="python-example",
                user_properties={"member_level": "gold"},
                analytics_dimensions={"client": "python"},
            )
        ):
            body, options = apply_ai_context_to_openai_request(
                client,
                {
                    "model": "text.fast",
                    "messages": [
                        {
                            "role": "user",
                            "content": "This content goes to LiteLLM, never the Control Plane.",
                        }
                    ],
                    "metadata": {"cp": {"forged": True}, "feature": "python-example"},
                },
                {"headers": {"x-litellm-tags": "caller-visible,cp:untrusted"}},
            )
        print(
            json.dumps(
                {
                    "refresh_status": refresh.status,
                    "runtime_version": refresh.version,
                    "sanitized_tags": options["headers"]["x-litellm-tags"],
                    "governed_context": "cp" in body["metadata"],
                    "lkg_path": lkg_path,
                }
            )
        )
    finally:
        client.close()


if __name__ == "__main__":
    main()

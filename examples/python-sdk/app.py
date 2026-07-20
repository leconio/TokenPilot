"""Call a virtual model with the trusted Python SDK without exposing request content."""

from __future__ import annotations

import json
import os

from ai_control_sdk import AiRuntimeClient, AiRuntimeContext, ai_context


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
                application_version="python-example-1.0.0",
                call_source="python-example",
                event_properties={"voice_enabled": False, "next_action": "confirm"},
                user_properties={"member_level": "gold"},
                analytics_dimensions={"client": "python"},
            )
        ):
            result = client.chat(
                model="customer-support",
                messages=[
                    {
                        "role": "user",
                        "content": "This content stays in the application request.",
                    }
                ],
            )
        print(
            json.dumps(
                {
                    "refresh_status": refresh.status,
                    "runtime_version": refresh.version,
                    "virtual_model": result.virtual_model,
                    "real_model": result.target.request_model,
                    "attempt_count": len(result.attempts),
                    "lkg_path": lkg_path,
                }
            )
        )
    finally:
        client.close()


if __name__ == "__main__":
    main()

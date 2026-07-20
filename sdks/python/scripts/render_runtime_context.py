"""Render one deterministic Runtime Context envelope for Node/Python parity tests."""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, cast

from ai_control_sdk import ResolvedAiRuntimeContext, RuntimeSnapshot
from ai_control_sdk.runtime.state import RuntimeState


def main() -> None:
    value = cast(dict[str, Any], json.load(sys.stdin))
    context = cast(dict[str, Any], value["context"])
    state = RuntimeState(
        lkg_path=Path(".unused-runtime-lkg.json"),
        fail_mode="fail_closed",
        now=lambda: datetime.fromisoformat(cast(str, value["issued_at"]).replace("Z", "+00:00")),
    )
    state.snapshot = RuntimeSnapshot.model_validate(value["snapshot"])
    envelope = state.metadata_envelope(
        ResolvedAiRuntimeContext(
            user_id=cast(str, context["user_id"]),
            display_user=cast(str | None, context["display_user"]),
            application_version=cast(str | None, context.get("application_version")),
            operation_id=cast(str, context["operation_id"]),
            request_id=cast(str, context["request_id"]),
            parent_request_id=cast(str | None, context.get("parent_request_id")),
            session_id=cast(str | None, context.get("session_id")),
            conversation_id=cast(str | None, context.get("conversation_id")),
            trace_id=cast(str, context["trace_id"]),
            call_source=cast(str | None, context["call_source"]),
            event_properties=cast(
                dict[str, str | int | float | bool | list[str]],
                context.get("event_properties", {}),
            ),
            user_properties=cast(
                dict[str, str | int | float | bool | list[str]], context["user_properties"]
            ),
            analytics_dimensions=cast(dict[str, str | int | bool], context["analytics_dimensions"]),
        )
    )
    envelope["sdk_version"] = cast(str, value["sdk_version"])
    json.dump(envelope, sys.stdout, separators=(",", ":"), sort_keys=True)


if __name__ == "__main__":
    main()

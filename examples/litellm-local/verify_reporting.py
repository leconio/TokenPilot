"""Poll the application usage report until the native LiteLLM attempts reach ClickHouse."""

from __future__ import annotations

import argparse
import json
import os
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", type=Path, default=Path(".tokenpilot/litellm-local-run.json"))
    parser.add_argument("--timeout", type=float, default=90)
    return parser.parse_args()


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise SystemExit(f"Set {name} in .env before verifying the report")
    return value


def report_items(payload: object) -> list[dict[str, Any]]:
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), dict):
        return []
    items = payload["data"].get("items")
    return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []


def processing_complete(
    client: httpx.Client,
    base: str,
    slug: str,
    headers: dict[str, str],
    items: list[dict[str, Any]],
) -> bool:
    expected_events = {str(item.get("event_id")) for item in items}
    request_ids = {str(item.get("request_id")) for item in items}
    observed_events: set[str] = set()
    for request_id in request_ids:
        response = client.get(f"{base}/applications/{slug}/requests/{request_id}", headers=headers)
        if response.status_code == 404:
            return False
        response.raise_for_status()
        payload = response.json()
        attempts = payload.get("attempts") if isinstance(payload, dict) else None
        if not isinstance(attempts, list):
            return False
        for attempt in attempts:
            if not isinstance(attempt, dict):
                continue
            raw_event = attempt.get("raw_event")
            if not isinstance(raw_event, dict):
                continue
            event_id = raw_event.get("event_id")
            if (
                isinstance(event_id, str)
                and attempt.get("model_cost") is not None
                and attempt.get("aiu") is not None
            ):
                observed_events.add(event_id)
    return observed_events >= expected_events


def assert_expected_events(items: list[dict[str, Any]], operations: set[str]) -> None:
    if {item.get("operation_id") for item in items} < operations:
        raise SystemExit("The report did not contain every example operation")
    statuses = [item.get("status") for item in items]
    if statuses.count("success") < 2 or statuses.count("failure") < 1:
        raise SystemExit("The success, failure, and fallback attempts were not all reported")
    for item in items:
        if item.get("user_id") != "local-example-user":
            raise SystemExit("The reported application user is incorrect")
        event_properties = item.get("event_properties")
        user_properties = item.get("user_properties")
        if not isinstance(event_properties, dict) or not isinstance(user_properties, dict):
            raise SystemExit("The typed example fields are missing")
        if not isinstance(event_properties.get("voice_enabled"), bool):
            raise SystemExit("The typed Boolean field did not retain its type")
        if user_properties.get("parse_context") != "native-mac":
            raise SystemExit("The typed user field is incorrect")
    serialized = json.dumps(items, ensure_ascii=False)
    if "This content must never be reported." in serialized or "local example result" in serialized:
        raise SystemExit("Prompt or response content appeared in the report")


def main() -> None:
    load_dotenv()
    options = arguments()
    evidence = json.loads(options.run.read_text(encoding="utf-8"))
    operations = set(evidence["operations"].values())
    started = datetime.fromisoformat(evidence["started_at"].replace("Z", "+00:00"))
    conditions = [
        {
            "kind": "builtin",
            "field": "operation_id",
            "operator": "one_of",
            "values": sorted(operations),
        }
    ]
    base = required("AI_CONTROL_URL").rstrip("/")
    slug = required("TOKENPILOT_APPLICATION_SLUG")
    url = f"{base}/applications/{slug}/reports/usage"
    headers = {"authorization": f"Bearer {required('TOKENPILOT_VERIFY_API_KEY')}"}
    deadline = time.monotonic() + options.timeout
    items: list[dict[str, Any]] = []
    with httpx.Client(timeout=10) as client:
        while time.monotonic() < deadline:
            response = client.get(
                url,
                headers=headers,
                params={
                    "from": (started - timedelta(minutes=5))
                    .astimezone(UTC)
                    .isoformat()
                    .replace("+00:00", "Z"),
                    "to": (datetime.now(UTC) + timedelta(minutes=1))
                    .isoformat()
                    .replace("+00:00", "Z"),
                    "timezone": "UTC",
                    "page_size": 20,
                    "group_dimension": "request_model",
                    "conditions": json.dumps(conditions, separators=(",", ":")),
                },
            )
            response.raise_for_status()
            items = report_items(response.json())
            if (
                len(items) >= 3
                and {item.get("operation_id") for item in items} >= operations
                and processing_complete(client, base, slug, headers, items)
            ):
                break
            time.sleep(1)
        else:
            raise SystemExit("Timed out before all LiteLLM attempts appeared in the usage report")
    assert_expected_events(items, operations)
    summary = {
        "application": slug,
        "events": [item.get("event_id") for item in items],
        "users": sorted({str(item.get("user_id")) for item in items}),
        "models": sorted({str(item.get("request_model")) for item in items}),
        "tokens": [
            {
                "input": item.get("input_tokens"),
                "cached_input": item.get("cached_input_tokens"),
                "output": item.get("output_tokens"),
                "reasoning_output": item.get("reasoning_output_tokens"),
                "total": item.get("total_tokens"),
            }
            for item in items
        ],
        "aiu_micros": [item.get("aiu_micros") for item in items],
        "fields": [
            {
                "next_action": item.get("event_properties", {}).get("next_action"),
                "parse_context": item.get("user_properties", {}).get("parse_context"),
            }
            for item in items
        ],
    }
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()

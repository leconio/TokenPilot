"""OpenAI-compatible and Anthropic HTTP request/usage helpers."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any, cast

import httpx

from .chat_types import ChatMessage, ProviderAttemptError
from .contracts import RuntimeCallConnection, RuntimeRouteTarget


def provider_request(
    connection: RuntimeCallConnection,
    request_model: str,
    messages: Sequence[ChatMessage],
    credential: str,
    *,
    max_tokens: int | None,
    temperature: float | None,
    tools: Sequence[Mapping[str, Any]] | None,
    response_format: Mapping[str, Any] | None,
) -> tuple[str, dict[str, str], dict[str, Any]]:
    if connection.driver == "anthropic":
        base_url = connection.base_url or "https://api.anthropic.com/v1"
        system = [message["content"] for message in messages if message.get("role") == "system"]
        body: dict[str, Any] = {
            "model": request_model,
            "max_tokens": max_tokens or 1_024,
            "messages": [message for message in messages if message.get("role") != "system"],
        }
        if system:
            body["system"] = system
        if temperature is not None:
            body["temperature"] = temperature
        if tools is not None:
            body["tools"] = list(tools)
        headers = {
            "content-type": "application/json",
            "anthropic-version": connection.api_version or "2023-06-01",
        }
        if credential:
            headers["x-api-key"] = credential
        return f"{base_url.rstrip('/')}/messages", headers, body

    if connection.base_url is None:
        raise ProviderAttemptError(
            "The selected connection has no base URL.",
            status=None,
            kind="failure",
            retryable=False,
        )
    body = {"model": request_model, "messages": list(messages), "stream": False}
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    if temperature is not None:
        body["temperature"] = temperature
    if tools is not None:
        body["tools"] = list(tools)
    if response_format is not None:
        body["response_format"] = dict(response_format)
    headers = {"content-type": "application/json"}
    if credential:
        headers["authorization"] = f"Bearer {credential}"
    return f"{connection.base_url.rstrip('/')}/chat/completions", headers, body


def _number(value: object) -> int:
    return int(value) if isinstance(value, int | float) and value >= 0 else 0


def usage(value: object, driver: str) -> dict[str, str]:
    raw = value.get("usage") if isinstance(value, Mapping) else None
    values = cast(Mapping[str, object], raw) if isinstance(raw, Mapping) else {}
    if driver == "anthropic":
        return {
            "uncached_input_tokens": str(_number(values.get("input_tokens"))),
            "cache_read_input_tokens": str(_number(values.get("cache_read_input_tokens"))),
            "cache_write_input_tokens": str(_number(values.get("cache_creation_input_tokens"))),
            "output_tokens": str(_number(values.get("output_tokens"))),
            "request_count": "1",
        }
    raw_details = values.get("prompt_tokens_details")
    details = cast(Mapping[str, object], raw_details) if isinstance(raw_details, Mapping) else {}
    raw_completion = values.get("completion_tokens_details")
    completion = (
        cast(Mapping[str, object], raw_completion) if isinstance(raw_completion, Mapping) else {}
    )
    input_tokens = _number(values.get("prompt_tokens"))
    cached = min(input_tokens, _number(details.get("cached_tokens")))
    return {
        "uncached_input_tokens": str(input_tokens - cached),
        "cache_read_input_tokens": str(cached),
        "output_tokens": str(_number(values.get("completion_tokens"))),
        "reasoning_output_tokens": str(_number(completion.get("reasoning_tokens"))),
        "request_count": "1",
    }


def stream_usage(value: object, driver: str) -> dict[str, str] | None:
    if not isinstance(value, Mapping):
        return None
    if driver != "anthropic":
        return usage(value, driver) if "usage" in value else None
    message = value.get("message")
    raw = message.get("usage") if isinstance(message, Mapping) else value.get("usage")
    return usage({"usage": raw}, driver) if isinstance(raw, Mapping) else None


def merge_usage(current: dict[str, str], next_usage: Mapping[str, str] | None) -> None:
    if next_usage is None:
        return
    for key, value in next_usage.items():
        try:
            current[key] = str(max(int(current.get(key, "0")), int(value)))
        except ValueError:
            current[key] = value


def stream_request(
    connection: RuntimeCallConnection,
    target: RuntimeRouteTarget,
    messages: Sequence[ChatMessage],
    credential: str,
    *,
    max_tokens: int | None,
    temperature: float | None,
    tools: Sequence[Mapping[str, Any]] | None,
    response_format: Mapping[str, Any] | None,
) -> tuple[str, dict[str, str], dict[str, Any]]:
    url, headers, body = provider_request(
        connection,
        target.request_model,
        messages,
        credential,
        max_tokens=max_tokens,
        temperature=temperature,
        tools=tools,
        response_format=response_format,
    )
    body["stream"] = True
    if connection.driver != "anthropic":
        body["stream_options"] = {"include_usage": True}
    return url, headers, body


def sse_value(line: str, status: int) -> object | None:
    if not line.startswith("data:"):
        return None
    data = line[5:].lstrip()
    if not data or data == "[DONE]":
        return None
    try:
        value: object = json.loads(data)
        return value
    except (TypeError, ValueError) as error:
        raise ProviderAttemptError(
            "Model service returned invalid streaming data.",
            status=status,
            kind="failure",
            retryable=False,
        ) from error


def provider_failure(error: Exception) -> ProviderAttemptError:
    if isinstance(error, ProviderAttemptError):
        return error
    if isinstance(error, httpx.TimeoutException):
        return ProviderAttemptError(
            "Model request timed out.", status=None, kind="timeout", retryable=True
        )
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        return ProviderAttemptError(
            f"Model service returned HTTP {status}.",
            status=status,
            kind="failure",
            retryable=status in {408, 409, 429} or status >= 500,
        )
    return ProviderAttemptError(
        "Model service request failed.", status=None, kind="failure", retryable=True
    )

"""Asynchronous non-streaming chat execution."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Mapping, Sequence
from typing import Any, cast

from ..errors import AiControlSdkError
from .chat_common import reservation_request, route_and_targets, usage_event
from .chat_types import (
    AiChatAttempt,
    AiChatResult,
    AsyncChatClient,
    ChatMessage,
    ProviderAttemptError,
    ProviderChatRequest,
)
from .context import new_ulid, require_ai_context
from .contracts import RuntimeUserReservation
from .provider_transport import provider_failure, provider_request, usage


async def execute_async_chat(
    client: AsyncChatClient,
    *,
    model: str,
    messages: Sequence[ChatMessage],
    max_tokens: int | None = None,
    temperature: float | None = None,
    tools: Sequence[Mapping[str, Any]] | None = None,
    response_format: Mapping[str, Any] | None = None,
    estimated_aiu_micros: str | None = None,
) -> AiChatResult:
    context = require_ai_context()
    if not messages:
        raise ValueError("chat messages cannot be empty")
    snapshot = client.snapshot
    if snapshot is None:
        raise AiControlSdkError("SDK_RUNTIME_UNAVAILABLE", "No Runtime Snapshot is loaded.")
    if snapshot.aiu.mode == "hard_limit" and estimated_aiu_micros is None:
        raise AiControlSdkError(
            "SDK_AIU_ESTIMATE_REQUIRED",
            "estimated_aiu_micros is required while the hard AIU limit is enabled.",
        )
    route, targets = route_and_targets(client, model, context, messages, tools, response_format)
    reservation = await client.reserve_user_aiu(
        reservation_request(context, model, targets, estimated_aiu_micros)
    )
    token = cast(RuntimeUserReservation | None, reservation.token)
    attempts: list[AiChatAttempt] = []
    events: list[Mapping[str, Any]] = []
    last_error: ProviderAttemptError | None = None
    attempt_index = 0
    for target_index, target in enumerate(targets):
        connection = snapshot.connections[target.connection_id]
        adapter = client.provider_adapter(connection)
        try:
            credential = (
                ""
                if adapter is not None and not adapter.requires_credential
                else await client.resolve_connection_credential(connection)
            )
        except Exception as error:
            client.on_error(error)
            last_error = ProviderAttemptError(
                str(error), status=None, kind="failure", retryable=True
            )
            continue
        for retry in range(connection.max_retries + 1):
            attempt_id = f"att_{new_ulid()}"
            started = time.perf_counter()
            status: int | None = None
            try:
                if adapter is None:
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
                    response = await client.provider_client.post(
                        url, headers=headers, json=body, timeout=connection.timeout_ms / 1_000
                    )
                    response.raise_for_status()
                    try:
                        value = response.json()
                    except ValueError as error:
                        raise ProviderAttemptError(
                            "Model service returned invalid JSON.",
                            status=response.status_code,
                            kind="failure",
                            retryable=False,
                        ) from error
                    if not isinstance(value, Mapping):
                        raise ProviderAttemptError(
                            "Model service returned an invalid response.",
                            status=response.status_code,
                            kind="failure",
                            retryable=False,
                        )
                    status = response.status_code
                    measured = usage(value, connection.driver)
                else:
                    adapted = await adapter.chat(
                        ProviderChatRequest(
                            model=model,
                            messages=messages,
                            target=target,
                            connection=connection,
                            credential=credential,
                            max_tokens=max_tokens,
                            temperature=temperature,
                            tools=tools,
                            response_format=response_format,
                        )
                    )
                    value = adapted.response
                    status = adapted.http_status
                    measured = dict(adapted.usage or {"request_count": "1"})
                attempt = AiChatAttempt(
                    attempt_id,
                    attempt_index,
                    target,
                    connection,
                    "success",
                    status,
                    round((time.perf_counter() - started) * 1_000),
                )
                attempts.append(attempt)
                events.append(
                    usage_event(
                        client,
                        context,
                        route,
                        targets,
                        target_index,
                        connection,
                        attempt,
                        measured,
                        final=True,
                        reservation_id=token.id if token is not None else None,
                    )
                )
                try:
                    await client.report_usage_events(events)
                except Exception as error:
                    client.on_error(error)
                if token is not None:
                    try:
                        await client.settle_user_aiu_reservation(token, estimated_aiu_micros or "0")
                    except Exception as error:
                        client.on_error(error)
                return AiChatResult(
                    value,
                    route.virtual_model,
                    target,
                    connection,
                    tuple(attempts),
                    context.operation_id,
                )
            except asyncio.CancelledError:
                attempt = AiChatAttempt(
                    attempt_id,
                    attempt_index,
                    target,
                    connection,
                    "cancelled",
                    status,
                    round((time.perf_counter() - started) * 1_000),
                )
                attempts.append(attempt)
                events.append(
                    usage_event(
                        client,
                        context,
                        route,
                        targets,
                        target_index,
                        connection,
                        attempt,
                        {"request_count": "1"},
                        final=True,
                        reservation_id=token.id if token is not None else None,
                    )
                )
                if token is not None:
                    try:
                        await client.release_user_aiu_reservation(
                            token, "model request was cancelled"
                        )
                    except Exception as error:
                        client.on_error(error)
                try:
                    await client.report_usage_events(events)
                except Exception as error:
                    client.on_error(error)
                raise
            except Exception as error:
                failure = provider_failure(error)
                last_error = failure
                final = not failure.retryable or (
                    target_index == len(targets) - 1 and retry == connection.max_retries
                )
                attempt = AiChatAttempt(
                    attempt_id,
                    attempt_index,
                    target,
                    connection,
                    failure.kind,
                    failure.status,
                    round((time.perf_counter() - started) * 1_000),
                )
                attempts.append(attempt)
                events.append(
                    usage_event(
                        client,
                        context,
                        route,
                        targets,
                        target_index,
                        connection,
                        attempt,
                        {"request_count": "1"},
                        final=final,
                        reservation_id=token.id if token is not None else None,
                    )
                )
                attempt_index += 1
                if not failure.retryable:
                    break
        if last_error is not None and not last_error.retryable:
            break
    if token is not None:
        try:
            await client.release_user_aiu_reservation(token, "all model attempts failed")
        except Exception as error:
            client.on_error(error)
    if events:
        try:
            await client.report_usage_events(events)
        except Exception as error:
            client.on_error(error)
    raise AiControlSdkError(
        "SDK_MODEL_REQUEST_FAILED",
        str(last_error) if last_error is not None else "No model target could be called.",
    )

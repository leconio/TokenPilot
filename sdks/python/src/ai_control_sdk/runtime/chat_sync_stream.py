"""Synchronous streaming chat execution."""

from __future__ import annotations

import time
from collections.abc import Generator, Mapping, Sequence
from typing import Any, cast

from ..errors import AiControlSdkError
from .chat_common import reservation_request, route_and_targets, usage_event
from .chat_types import (
    AiChatAttempt,
    AiChatResult,
    ChatMessage,
    ProviderAttemptError,
    ProviderChatRequest,
    SyncChatClient,
)
from .context import new_ulid, require_ai_context
from .contracts import RuntimeUserReservation
from .provider_transport import (
    merge_usage,
    provider_failure,
    sse_value,
    stream_request,
    stream_usage,
)
from .source_cost import SourceCost


def execute_chat_stream(
    client: SyncChatClient,
    *,
    model: str,
    messages: Sequence[ChatMessage],
    max_tokens: int | None = None,
    temperature: float | None = None,
    tools: Sequence[Mapping[str, Any]] | None = None,
    response_format: Mapping[str, Any] | None = None,
    estimated_aiu_micros: str | None = None,
) -> Generator[Any, None, AiChatResult]:
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
    route, targets = route_and_targets(
        client, model, context, messages, tools, response_format, streaming=True
    )
    reservation = client.reserve_user_aiu(
        reservation_request(context, model, targets, estimated_aiu_micros)
    )
    token = cast(RuntimeUserReservation | None, reservation.token)
    attempts: list[AiChatAttempt] = []
    events: list[Mapping[str, Any]] = []
    attempt_index = 0
    last_error: ProviderAttemptError | None = None
    for target_index, target in enumerate(targets):
        connection = snapshot.connections[target.connection_id]
        adapter = client.provider_adapter(connection)
        try:
            credential = (
                ""
                if adapter is not None and not adapter.requires_credential
                else client.resolve_connection_credential(connection)
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
            measured = {"request_count": "1"}
            source_cost: SourceCost | None = None
            status: int | None = None
            emitted = False
            try:
                if adapter is None:
                    url, headers, body = stream_request(
                        connection,
                        target,
                        messages,
                        credential,
                        max_tokens=max_tokens,
                        temperature=temperature,
                        tools=tools,
                        response_format=response_format,
                    )
                    with client.provider_client.stream(
                        "POST",
                        url,
                        headers=headers,
                        json=body,
                        timeout=connection.timeout_ms / 1_000,
                    ) as response:
                        status = response.status_code
                        response.raise_for_status()
                        for line in response.iter_lines():
                            value = sse_value(line, response.status_code)
                            if value is None:
                                continue
                            emitted = True
                            merge_usage(measured, stream_usage(value, connection.driver))
                            yield value
                else:
                    adapted = adapter.stream(
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
                    status = adapted.http_status
                    for part in adapted.stream:
                        emitted = True
                        merge_usage(measured, part.usage)
                        if part.source_cost is not None:
                            source_cost = part.source_cost
                        yield part.value
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
                        source_cost,
                        final=True,
                        reservation_id=token.id if token is not None else None,
                    )
                )
                try:
                    client.report_usage_events(events)
                except Exception as error:
                    client.on_error(error)
                if token is not None:
                    try:
                        client.settle_user_aiu_reservation(token, estimated_aiu_micros or "0")
                    except Exception as error:
                        client.on_error(error)
                return AiChatResult(
                    None,
                    route.virtual_model,
                    target,
                    connection,
                    tuple(attempts),
                    context.operation_id,
                )
            except GeneratorExit:
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
                        measured,
                        source_cost,
                        final=True,
                        reservation_id=token.id if token is not None else None,
                    )
                )
                if token is not None:
                    try:
                        client.release_user_aiu_reservation(token, "stream was cancelled")
                    except Exception as error:
                        client.on_error(error)
                try:
                    client.report_usage_events(events)
                except Exception as error:
                    client.on_error(error)
                raise
            except Exception as error:
                failure = provider_failure(error)
                if emitted and failure.retryable:
                    failure = ProviderAttemptError(
                        str(failure),
                        status=failure.status,
                        kind=failure.kind,
                        retryable=False,
                    )
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
                        measured,
                        source_cost,
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
            client.release_user_aiu_reservation(token, "all model attempts failed")
        except Exception as error:
            client.on_error(error)
    if events:
        try:
            client.report_usage_events(events)
        except Exception as error:
            client.on_error(error)
    raise AiControlSdkError(
        "SDK_MODEL_REQUEST_FAILED",
        str(last_error) if last_error is not None else "No model target could be called.",
    )

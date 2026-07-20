"""Public provider adapter and chat result contracts."""

from __future__ import annotations

import inspect
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import httpx

from .contracts import RuntimeCallConnection, RuntimeRouteTarget, RuntimeUserReservation
from .routing import RuntimeRouteContext, RuntimeRouteSelection

ChatMessage = Mapping[str, Any]
CredentialResolver = Callable[[str, RuntimeCallConnection], str]
AsyncCredentialResolver = Callable[[str, RuntimeCallConnection], str | Awaitable[str]]


@dataclass(frozen=True, slots=True)
class AiChatAttempt:
    attempt_id: str
    attempt_index: int
    target: RuntimeRouteTarget
    connection: RuntimeCallConnection
    status: Literal["success", "failure", "timeout", "cancelled"]
    http_status: int | None
    latency_ms: int


@dataclass(frozen=True, slots=True)
class AiChatResult:
    response: Any
    virtual_model: str
    target: RuntimeRouteTarget
    connection: RuntimeCallConnection
    attempts: tuple[AiChatAttempt, ...]
    operation_id: str


@dataclass(frozen=True, slots=True)
class ProviderChatRequest:
    model: str
    messages: Sequence[ChatMessage]
    target: RuntimeRouteTarget
    connection: RuntimeCallConnection
    credential: str
    max_tokens: int | None
    temperature: float | None
    tools: Sequence[Mapping[str, Any]] | None
    response_format: Mapping[str, Any] | None


@dataclass(frozen=True, slots=True)
class ProviderChatResponse:
    response: Any
    http_status: int = 200
    usage: Mapping[str, str] | None = None


@dataclass(frozen=True, slots=True)
class ProviderStreamPart:
    value: Any
    usage: Mapping[str, str] | None = None


@dataclass(frozen=True, slots=True)
class ProviderChatStreamResponse:
    stream: Iterable[ProviderStreamPart]
    http_status: int = 200


@dataclass(frozen=True, slots=True)
class AsyncProviderChatStreamResponse:
    stream: AsyncIterator[ProviderStreamPart]
    http_status: int = 200


class SyncProviderAdapter(Protocol):
    requires_credential: bool

    def chat(self, request: ProviderChatRequest) -> ProviderChatResponse: ...

    def stream(self, request: ProviderChatRequest) -> ProviderChatStreamResponse: ...


class AsyncProviderAdapter(Protocol):
    requires_credential: bool

    async def chat(self, request: ProviderChatRequest) -> ProviderChatResponse: ...

    async def stream(self, request: ProviderChatRequest) -> AsyncProviderChatStreamResponse: ...


class SyncChatClient(Protocol):
    connector_identity: Any
    provider_client: httpx.Client
    on_error: Callable[[Exception], None]

    @property
    def snapshot(self) -> Any: ...

    def select_route(
        self, virtual_model: str, context: RuntimeRouteContext | None = None
    ) -> RuntimeRouteSelection: ...

    def reserve_user_aiu(self, value: Mapping[str, Any]) -> Any: ...

    def release_user_aiu_reservation(self, token: RuntimeUserReservation, reason: str) -> None: ...

    def settle_user_aiu_reservation(
        self, token: RuntimeUserReservation, settled_aiu_micros: str
    ) -> None: ...

    def resolve_connection_credential(self, connection: RuntimeCallConnection) -> str: ...

    def report_usage_events(self, events: Sequence[Mapping[str, Any]]) -> None: ...

    def provider_adapter(self, connection: RuntimeCallConnection) -> SyncProviderAdapter | None: ...


class AsyncChatClient(Protocol):
    connector_identity: Any
    provider_client: httpx.AsyncClient
    on_error: Callable[[Exception], None]

    @property
    def snapshot(self) -> Any: ...

    def select_route(
        self, virtual_model: str, context: RuntimeRouteContext | None = None
    ) -> RuntimeRouteSelection: ...

    async def reserve_user_aiu(self, value: Mapping[str, Any]) -> Any: ...

    async def release_user_aiu_reservation(
        self, token: RuntimeUserReservation, reason: str
    ) -> None: ...

    async def settle_user_aiu_reservation(
        self, token: RuntimeUserReservation, settled_aiu_micros: str
    ) -> None: ...

    async def resolve_connection_credential(self, connection: RuntimeCallConnection) -> str: ...

    async def report_usage_events(self, events: Sequence[Mapping[str, Any]]) -> None: ...

    def provider_adapter(
        self, connection: RuntimeCallConnection
    ) -> AsyncProviderAdapter | None: ...


class ProviderAttemptError(Exception):
    def __init__(
        self,
        message: str,
        *,
        status: int | None,
        kind: Literal["failure", "timeout", "cancelled"],
        retryable: bool,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.kind = kind
        self.retryable = retryable


async def resolve_async_credential(
    resolver: AsyncCredentialResolver,
    reference: str,
    connection: RuntimeCallConnection,
) -> str:
    value = resolver(reference, connection)
    return await value if inspect.isawaitable(value) else value

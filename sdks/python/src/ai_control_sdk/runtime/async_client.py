"""Asynchronous current Runtime Snapshot and application-user AIU client."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Callable, Mapping, Sequence
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Self
from urllib.parse import quote

import httpx

from ..errors import AiControlSdkError
from .acknowledgements import AcknowledgementState, runtime_acknowledgements
from .chat import (
    AiChatResult,
    AsyncCredentialResolver,
    AsyncProviderAdapter,
    ChatMessage,
    execute_async_chat,
    execute_async_chat_stream,
)
from .client_helpers import (
    fail_open_or_raise,
    normalize_control_plane_url,
    resolve_async_connection_credential,
)
from .context import ResolvedAiRuntimeContext
from .contracts import (
    RuntimeCallConnection,
    RuntimeConfigurationAcknowledgement,
    RuntimeConnectorIdentity,
    RuntimeRefreshResult,
    RuntimeSnapshot,
    RuntimeUserReservation,
    RuntimeUserReservationRequest,
    RuntimeUserReservationResponse,
    SdkReservationResult,
)
from .manual_usage import RecordUsageInput, build_manual_usage_event
from .routing import RuntimeRouteContext, RuntimeRouteSelection, resolve_runtime_route
from .state import RuntimeFailMode, RuntimeState
from .usage_reporting import enqueue_usage, flush_async_usage, usage_spool
from .usage_spool import DurableUsageSpool


class AsyncAiRuntimeClient:
    def __init__(
        self,
        *,
        control_plane_url: str,
        api_key: str,
        instance_id: str = "python-sdk",
        sdk_version: str = "0.2.0",
        lkg_path: str | Path = ".tokenpilot/runtime-snapshot.json",
        fail_mode: RuntimeFailMode = "fail_open",
        http_client: httpx.AsyncClient | None = None,
        provider_http_client: httpx.AsyncClient | None = None,
        credentials: Mapping[str, str] | None = None,
        credential_resolver: AsyncCredentialResolver | None = None,
        provider_adapters: Mapping[str, AsyncProviderAdapter] | None = None,
        connection_adapters: Mapping[str, AsyncProviderAdapter] | None = None,
        usage_spool_path: str | Path | None = None,
        usage_spool_max_bytes: int = 64 * 1024 * 1024,
        usage_batch_size: int = 100,
        refresh_interval_seconds: float = 30.0,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        on_error: Callable[[Exception], None] = lambda _error: None,
    ) -> None:
        if len(api_key) < 16:
            raise AiControlSdkError("SDK_INVALID_CONFIGURATION", "A server API key is required.")
        self.control_plane_url = normalize_control_plane_url(control_plane_url)
        self.api_key = api_key
        self.connector_identity = RuntimeConnectorIdentity(
            instance_id=instance_id, name="python", version=sdk_version
        )
        self.pending_acknowledgements: list[RuntimeConfigurationAcknowledgement] = []
        self.client = http_client or httpx.AsyncClient(timeout=10)
        self.owns_client = http_client is None
        self.provider_client = provider_http_client or httpx.AsyncClient()
        self.owns_provider_client = provider_http_client is None
        self.credentials = dict(credentials or {})
        self.credential_resolver = credential_resolver
        self.provider_adapters = dict(provider_adapters or {})
        self.connection_adapters = dict(connection_adapters or {})
        lkg = Path(lkg_path).expanduser().resolve()
        self.usage_spool_path = (
            Path(usage_spool_path).expanduser().resolve()
            if usage_spool_path is not None
            else lkg.parent / "usage-spool.sqlite3"
        )
        if not 1 <= usage_batch_size <= 1_000:
            raise AiControlSdkError(
                "SDK_INVALID_CONFIGURATION", "usage_batch_size must be between 1 and 1000."
            )
        self.usage_spool_max_bytes = usage_spool_max_bytes
        self.usage_batch_size = usage_batch_size
        if refresh_interval_seconds != 0 and refresh_interval_seconds < 1:
            raise AiControlSdkError(
                "SDK_INVALID_CONFIGURATION",
                "refresh_interval_seconds must be 0 or at least 1 second.",
            )
        self.refresh_interval_seconds = refresh_interval_seconds
        self._refresh_task: asyncio.Task[None] | None = None
        self.usage_spool = (
            DurableUsageSpool(self.usage_spool_path, usage_spool_max_bytes)
            if self.usage_spool_path.exists()
            else None
        )
        self.on_error = on_error
        options: dict[str, Any] = {
            "lkg_path": lkg,
            "fail_mode": fail_mode,
            "now": now,
        }
        self.state = RuntimeState(**options)

    @property
    def snapshot(self) -> RuntimeSnapshot | None:
        return self.state.snapshot.model_copy(deep=True) if self.state.snapshot else None

    async def load_lkg(self) -> bool:
        return await asyncio.to_thread(self.state.load_lkg)

    async def start(self) -> RuntimeRefreshResult:
        """Load current configuration and refresh it without restarting the application."""
        result = await self.refresh()
        if self.refresh_interval_seconds > 0 and self._refresh_task is None:
            self._refresh_task = asyncio.create_task(
                self._refresh_loop(), name="tokenpilot-runtime-refresh"
            )
        return result

    async def refresh(self) -> RuntimeRefreshResult:
        try:
            await self._flush_acknowledgements(required=True)
            headers = {"authorization": f"Bearer {self.api_key}"}
            if self.state.snapshot is not None:
                headers["if-none-match"] = f'"{self.state.snapshot.etag}"'
            response = await self.client.get(
                f"{self.control_plane_url}/runtime/snapshot", headers=headers
            )
            if response.status_code == 304:
                if self.state.snapshot is None:
                    raise AiControlSdkError(
                        "SDK_UNEXPECTED_NOT_MODIFIED",
                        "Received 304 without a local Runtime Snapshot.",
                    )
                self.state.validate_remote_current()
                self.state.source = "remote"
                await self._flush_usage_quietly()
                return self.state.result("not_modified")
            response.raise_for_status()
            raw_snapshot = response.json()
            try:
                snapshot = RuntimeSnapshot.model_validate(raw_snapshot)
                self.state.validate_remote(snapshot)
            except Exception as error:
                self._queue_acknowledgements(raw_snapshot, "rejected", error)
                await self._flush_acknowledgements(required=False)
                raise
            self._queue_acknowledgements(snapshot, "received")
            await self._flush_acknowledgements(required=True)
            try:
                await asyncio.to_thread(self.state.commit_remote, snapshot)
            except Exception as error:
                self._queue_acknowledgements(snapshot, "rejected", error)
                await self._flush_acknowledgements(required=False)
                raise
            self._queue_acknowledgements(snapshot, "applied")
            await self._flush_acknowledgements(required=False)
            await self._flush_usage_quietly()
            return self.state.result("updated")
        except Exception as error:
            self.on_error(error)
            if self.state.snapshot is None:
                await self.load_lkg()
            if self.state.snapshot is None:
                raise
            self.state.source = "lkg"
            return self.state.result("lkg")

    def create_metadata_envelope(self, context: ResolvedAiRuntimeContext) -> dict[str, Any]:
        return {
            **self.state.metadata_envelope(context),
            "sdk_version": self.connector_identity.version,
        }

    def select_route(
        self,
        virtual_model: str,
        context: RuntimeRouteContext | None = None,
        instant: datetime | None = None,
    ) -> RuntimeRouteSelection:
        return resolve_runtime_route(
            self.state.require_usable_snapshot(),
            virtual_model,
            instant or self.state.now(),
            context,
        )

    async def chat(
        self,
        *,
        model: str,
        messages: list[ChatMessage],
        max_tokens: int | None = None,
        temperature: float | None = None,
        tools: list[Mapping[str, Any]] | None = None,
        response_format: Mapping[str, Any] | None = None,
        estimated_aiu_micros: str | None = None,
    ) -> AiChatResult:
        return await execute_async_chat(
            self,
            model=model,
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
            tools=tools,
            response_format=response_format,
            estimated_aiu_micros=estimated_aiu_micros,
        )

    def register_provider_adapter(self, driver: str, adapter: AsyncProviderAdapter) -> Self:
        if driver not in {"litellm", "openai_compatible", "anthropic"}:
            raise ValueError("driver is not supported")
        self.provider_adapters[driver] = adapter
        return self

    def register_connection_adapter(
        self, connection_id: str, adapter: AsyncProviderAdapter
    ) -> Self:
        if not connection_id.strip():
            raise ValueError("connection_id is required")
        self.connection_adapters[connection_id] = adapter
        return self

    def provider_adapter(self, connection: RuntimeCallConnection) -> AsyncProviderAdapter | None:
        return self.connection_adapters.get(connection.id) or self.provider_adapters.get(
            connection.driver
        )

    def now(self) -> datetime:
        return self.state.now()

    async def record_usage(self, input: RecordUsageInput) -> dict[str, Any]:
        event = build_manual_usage_event(self, input)
        await self.report_usage_events([event])
        return event

    def chat_stream(
        self,
        *,
        model: str,
        messages: list[ChatMessage],
        max_tokens: int | None = None,
        temperature: float | None = None,
        tools: list[Mapping[str, Any]] | None = None,
        response_format: Mapping[str, Any] | None = None,
        estimated_aiu_micros: str | None = None,
    ) -> AsyncGenerator[Any, None]:
        return execute_async_chat_stream(
            self,
            model=model,
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
            tools=tools,
            response_format=response_format,
            estimated_aiu_micros=estimated_aiu_micros,
        )

    async def reserve_user_aiu(
        self, value: RuntimeUserReservationRequest | Mapping[str, Any]
    ) -> SdkReservationResult:
        snapshot = self.state.require_usable_snapshot()
        if snapshot.aiu.mode != "hard_limit":
            return SdkReservationResult(status="not_required", network_used=False, token=None)
        request = RuntimeUserReservationRequest.model_validate(value)
        try:
            response = await self._request(
                "/runtime/users/aiu/reservations", request.model_dump(mode="json")
            )
            result = RuntimeUserReservationResponse.model_validate(response.json())
            if not result.allowed:
                raise AiControlSdkError(
                    "SDK_USER_AIU_DENIED", f"AIU access denied: {result.reason}"
                )
            return SdkReservationResult(
                status="allowed" if result.reservation is None else "reserved",
                network_used=True,
                token=result.reservation,
                response=result,
            )
        except Exception as error:
            return self._fail_open_or_raise(
                error,
                SdkReservationResult(status="fail_open", network_used=True, token=None),
            )

    async def settle_user_aiu_reservation(
        self, token: RuntimeUserReservation, settled_aiu_micros: str
    ) -> None:
        await self._request(
            f"/runtime/users/aiu/reservations/{quote(token.id, safe='')}/settle",
            {"reservation_token": token.token, "settled_aiu_micros": settled_aiu_micros},
        )

    async def release_user_aiu_reservation(
        self, token: RuntimeUserReservation, reason: str
    ) -> None:
        await self._request(
            f"/runtime/users/aiu/reservations/{quote(token.id, safe='')}/release",
            {"reservation_token": token.token, "reason": reason},
        )

    async def close(self) -> None:
        if self._refresh_task is not None:
            self._refresh_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._refresh_task
            self._refresh_task = None
        if self.owns_client:
            await self.client.aclose()
        if self.owns_provider_client:
            await self.provider_client.aclose()
        if self.usage_spool is not None:
            self.usage_spool.close()
            self.usage_spool = None

    async def _refresh_loop(self) -> None:
        while True:
            await asyncio.sleep(self.refresh_interval_seconds)
            try:
                await self.refresh()
            except Exception as error:
                self.on_error(error)

    async def resolve_connection_credential(self, connection: RuntimeCallConnection) -> str:
        return await resolve_async_connection_credential(
            connection, self.credentials, self.credential_resolver
        )

    async def report_usage_events(self, events: Sequence[Mapping[str, Any]]) -> None:
        if enqueue_usage(self, events):
            await self.flush_usage()

    async def flush_usage(self) -> int:
        return await flush_async_usage(self)

    def _usage_spool(self) -> DurableUsageSpool:
        return usage_spool(self)

    async def _flush_usage_quietly(self) -> None:
        if self.usage_spool is None:
            return
        try:
            await self.flush_usage()
        except Exception as error:
            self.on_error(error)

    async def _request(self, path: str, body: object) -> httpx.Response:
        response = await self.client.post(
            f"{self.control_plane_url}{path}",
            headers={"authorization": f"Bearer {self.api_key}"},
            json=body,
        )
        response.raise_for_status()
        return response

    def _queue_acknowledgements(
        self,
        value: object,
        state: AcknowledgementState,
        error: Exception | None = None,
    ) -> None:
        self.pending_acknowledgements.extend(
            runtime_acknowledgements(value, state, self.connector_identity, self.state.now(), error)
        )

    async def _flush_acknowledgements(self, *, required: bool) -> None:
        while self.pending_acknowledgements:
            try:
                response = await self.client.post(
                    f"{self.control_plane_url}/runtime/configuration-acknowledgements",
                    headers={"authorization": f"Bearer {self.api_key}"},
                    json=self.pending_acknowledgements[0].model_dump(mode="json"),
                )
                response.raise_for_status()
                self.pending_acknowledgements.pop(0)
            except Exception as error:
                if required:
                    raise
                self.on_error(error)
                return

    def _fail_open_or_raise[T](self, error: Exception, fallback: T) -> T:
        return fail_open_or_raise(self.state.fail_mode, self.on_error, error, fallback)

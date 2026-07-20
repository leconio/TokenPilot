"""Asynchronous current Runtime Snapshot and application-user AIU client."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

from ..errors import AiControlSdkError
from .acknowledgements import AcknowledgementState, runtime_acknowledgements
from .client import normalize_control_plane_url
from .context import ResolvedAiRuntimeContext
from .contracts import (
    RuntimeConfigurationAcknowledgement,
    RuntimeConnectorIdentity,
    RuntimeRefreshResult,
    RuntimeSnapshot,
    RuntimeUserReservation,
    RuntimeUserReservationRequest,
    RuntimeUserReservationResponse,
    SdkReservationResult,
)
from .routing import RuntimeRouteContext, RuntimeRouteSelection, resolve_runtime_route
from .state import RuntimeFailMode, RuntimeState


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
        self.on_error = on_error
        options: dict[str, Any] = {
            "lkg_path": Path(lkg_path).expanduser().resolve(),
            "fail_mode": fail_mode,
            "now": now,
        }
        self.state = RuntimeState(**options)

    @property
    def snapshot(self) -> RuntimeSnapshot | None:
        return self.state.snapshot.model_copy(deep=True) if self.state.snapshot else None

    async def load_lkg(self) -> bool:
        return await asyncio.to_thread(self.state.load_lkg)

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
        if self.owns_client:
            await self.client.aclose()

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
        self.on_error(error)
        if self.state.fail_mode == "fail_closed":
            raise error
        return fallback

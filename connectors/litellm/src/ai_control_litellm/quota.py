"""Application-user AIU access check performed before a LiteLLM call."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from uuid import uuid4

import httpx

from .config import ConnectorConfig
from .logging import log_event


def _mapping(value: object) -> Mapping[str, object]:
    return value if isinstance(value, Mapping) else {}


def _text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    return candidate if candidate else None


class UserQuotaClient:
    """Reserve AIU against the user list owned by the current application key."""

    def __init__(
        self,
        config: ConnectorConfig,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.config = config
        self._client = client

    async def apply_to_request(self, data: Mapping[str, object]) -> dict[str, object]:
        output = dict(data)
        metadata = dict(_mapping(output.get("metadata")))
        route = _mapping(metadata.get("cp_route"))
        if not self.config.quota_enabled or route.get("quota_mode") != "hard_limit":
            return output

        cp = dict(_mapping(metadata.get("cp")))
        operation_id = _text(cp.get("operation_id")) or f"op-{uuid4()}"
        user_id = _text(cp.get("user_id"))
        if user_id is None:
            raise PermissionError("AIU access denied: user_id_required")
        virtual_model = _text(route.get("virtual_model"))
        candidate_values = route.get("candidate_model_ids")
        candidates = (
            [item for item in candidate_values if isinstance(item, str)]
            if isinstance(candidate_values, list)
            else []
        )
        if virtual_model is None or not candidates:
            return self._failure(output, "RUNTIME_ROUTE_HAS_NO_RESERVATION_CANDIDATES")
        estimate = _text(cp.get("estimated_aiu_micros"))
        if estimate is None or not estimate.isdigit():
            estimate = str(self.config.reservation_aiu_micros)
        payload: dict[str, object] = {
            "user_id": user_id,
            "operation_id": operation_id,
            "virtual_model": virtual_model,
            "candidate_model_ids": candidates,
            "estimated_aiu_micros": estimate,
        }
        display_user = _text(cp.get("display_user"))
        if display_user is not None:
            payload["display_user"] = display_user
        user_properties = cp.get("user_properties")
        if isinstance(user_properties, Mapping):
            payload["user_properties"] = dict(user_properties)

        try:
            response = await self._post(payload)
            response.raise_for_status()
            body = response.json()
            if not isinstance(body, Mapping) or not isinstance(body.get("allowed"), bool):
                raise ValueError("The AIU access response is invalid")
        except Exception as error:
            log_event(
                logging.ERROR,
                "USER_AIU_ACCESS_CHECK_FAILED",
                {"error_type": type(error).__name__},
            )
            if self.config.quota_fail_closed:
                raise RuntimeError("AIU access could not be verified") from error
            return output

        if body["allowed"] is not True:
            reason = _text(body.get("reason")) or "access_denied"
            raise PermissionError(f"AIU access denied: {reason}")
        reservation = _mapping(body.get("reservation"))
        reservation_id = _text(reservation.get("id"))
        cp.update(
            {
                "context_version": _text(cp.get("context_version")) or "1",
                "operation_id": operation_id,
                "user_id": user_id,
            }
        )
        if reservation_id is not None:
            cp["reservation_id"] = reservation_id
        for key in ("virtual_model", "model_id", "model_tag", "configuration_version"):
            value = route.get(key)
            if isinstance(value, str | int):
                cp[key] = str(value)
        metadata["cp"] = cp
        output["metadata"] = metadata
        return output

    async def _post(self, payload: Mapping[str, object]) -> httpx.Response:
        key = self.config.policy_api_key
        if key is None:
            raise ValueError("A runtime API key is required for AIU access checks")
        headers = {"authorization": f"Bearer {key}"}
        if self._client is not None:
            return await self._client.post(
                self.config.user_reservation_url,
                headers=headers,
                json=dict(payload),
            )
        async with httpx.AsyncClient(timeout=self.config.request_timeout_seconds) as client:
            return await client.post(
                self.config.user_reservation_url,
                headers=headers,
                json=dict(payload),
            )

    def _failure(self, output: dict[str, object], code: str) -> dict[str, object]:
        log_event(logging.ERROR, code, {})
        if self.config.quota_fail_closed:
            raise RuntimeError("AIU access could not be verified")
        return output

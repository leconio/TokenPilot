"""ETag polling, durable LKG, acknowledgements, and request routing."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
import threading
from collections.abc import Mapping
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

import httpx

from .config import ConnectorConfig
from .identifiers import new_ulid
from .logging import log_event
from .machine_contracts import CanonicalRuntimeSnapshot
from .runtime_routing import RouteSelection, select_runtime_route


def _now_string(now: datetime | None = None) -> str:
    return (now or datetime.now(UTC)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _fingerprint(value: object) -> str:
    return f"sha256:{hashlib.sha256(_canonical(value).encode()).hexdigest()}"


def _policy_key_fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _verified_snapshot(
    value: object, now: datetime, *, allow_expired: bool
) -> CanonicalRuntimeSnapshot:
    snapshot = CanonicalRuntimeSnapshot.model_validate(value)
    unsigned = snapshot.model_dump(
        mode="json",
        by_alias=True,
        exclude={"etag", "signature"},
        exclude_none=True,
    )
    if snapshot.etag != _fingerprint(unsigned):
        raise ValueError("Runtime Snapshot checksum mismatch")
    binding = {"application_id": str(snapshot.application_id), "etag": snapshot.etag}
    if snapshot.signature != _fingerprint(binding):
        raise ValueError("Runtime Snapshot application signature mismatch")
    if not allow_expired and _parse_time(snapshot.expires_at) <= now:
        raise ValueError("Runtime Snapshot is expired")
    return snapshot


def _atomic_write(
    path: Path,
    snapshot: CanonicalRuntimeSnapshot,
    policy_api_key: str | None,
) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            envelope = {
                "application_id": str(snapshot.application_id),
                "policy_key_fingerprint": (
                    _policy_key_fingerprint(policy_api_key) if policy_api_key is not None else None
                ),
                "snapshot": snapshot.model_dump(mode="json", by_alias=True, exclude_none=True),
            }
            file.write(_canonical(envelope))
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    except Exception:
        with suppress(FileNotFoundError):
            os.unlink(temporary)
        raise


class RuntimePolicyClient:
    def __init__(self, config: ConnectorConfig) -> None:
        self.config = config
        self._client = httpx.Client(timeout=config.request_timeout_seconds)
        self._lock = threading.RLock()
        self._snapshot: CanonicalRuntimeSnapshot | None = None
        self._pending_acks: list[dict[str, object]] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        try:
            self.load_lkg()
        except Exception as error:
            log_event(
                logging.ERROR,
                "RUNTIME_POLICY_LKG_REJECTED",
                {"error_type": type(error).__name__},
            )
        if self.config.policy_api_key is None:
            return
        self._thread = threading.Thread(target=self._run, name="tokenpilot-policy", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
        self._thread = None
        self._client.close()

    def load_lkg(self) -> bool:
        try:
            envelope = json.loads(self.config.policy_lkg_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return False
        if not isinstance(envelope, Mapping):
            raise ValueError("Runtime Snapshot LKG envelope is invalid")
        value = envelope.get("snapshot")
        candidate = _verified_snapshot(value, datetime.now(UTC), allow_expired=False)
        if envelope.get("application_id") != str(candidate.application_id):
            raise ValueError("Runtime Snapshot LKG application binding mismatch")
        stored_key_fingerprint = envelope.get("policy_key_fingerprint")
        if self.config.policy_api_key is None:
            raise ValueError("A policy API key is required to load Runtime Snapshot LKG")
        if stored_key_fingerprint != _policy_key_fingerprint(self.config.policy_api_key):
            raise ValueError("Runtime Snapshot LKG policy-key binding mismatch")
        with self._lock:
            self._snapshot = candidate
        self._queue_acknowledgement(
            candidate.model_dump(mode="json", by_alias=True, exclude_none=True),
            "applied",
        )
        return True

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.refresh_once()
            except Exception as error:
                log_event(
                    logging.ERROR,
                    "RUNTIME_POLICY_REFRESH_FAILED",
                    {"error_type": type(error).__name__},
                )
            self._stop.wait(self.config.policy_poll_interval_seconds)

    def refresh_once(self) -> Literal["updated", "not_modified"]:
        if self.config.policy_api_key is None:
            raise ValueError("A policy API key is required to refresh Runtime Snapshot")
        self._flush_acks(required=True)
        with self._lock:
            current = self._snapshot
        headers = {"authorization": f"Bearer {self.config.policy_api_key}"}
        if current is not None:
            headers["if-none-match"] = f'"{current.etag}"'
        response = self._client.get(self.config.runtime_snapshot_url, headers=headers)
        if response.status_code == 304:
            return "not_modified"
        response.raise_for_status()
        raw = response.json()
        try:
            candidate = _verified_snapshot(raw, datetime.now(UTC), allow_expired=False)
            if current is not None and candidate.application_id != current.application_id:
                raise ValueError("Runtime Snapshot application binding changed")
            if (
                current is not None
                and candidate.version == current.version
                and candidate.etag != current.etag
            ):
                raise ValueError("Runtime Snapshot version collision")
        except Exception as error:
            self._queue_acknowledgement(raw, "rejected", error)
            self._flush_acks(required=False)
            raise
        self._queue_acknowledgement(raw, "received")
        self._flush_acks(required=True)
        try:
            _atomic_write(self.config.policy_lkg_path, candidate, self.config.policy_api_key)
        except Exception as error:
            self._queue_acknowledgement(raw, "rejected", error)
            self._flush_acks(required=False)
            raise
        with self._lock:
            self._snapshot = candidate
        self._queue_acknowledgement(raw, "applied")
        self._flush_acks(required=False)
        return "updated"

    def _queue_acknowledgement(
        self,
        raw: object,
        state: Literal["received", "applied", "rejected"],
        error: Exception | None = None,
    ) -> None:
        routing = raw.get("routing") if isinstance(raw, Mapping) else None
        if not isinstance(routing, Mapping):
            return
        versions = {
            plan.get("configuration_version")
            for plan in routing.values()
            if isinstance(plan, Mapping) and isinstance(plan.get("configuration_version"), int)
        }
        etag = raw.get("etag") if isinstance(raw, Mapping) else None
        application_id = raw.get("application_id") if isinstance(raw, Mapping) else None
        if len(versions) != 1 or not isinstance(etag, str) or not isinstance(application_id, str):
            return
        version = next(iter(versions))
        now = datetime.now(UTC)
        self._pending_acks.append(
            {
                "schema_version": "2.0",
                "application_id": application_id,
                "acknowledgement_id": new_ulid(now),
                "acknowledged_at": _now_string(now),
                "connector": {
                    "instance_id": self.config.instance_id,
                    "name": "litellm",
                    "version": self.config.connector_version,
                },
                "configuration_version": version,
                "configuration_etag": etag,
                "state": state,
                "applied_at": _now_string(now) if state == "applied" else None,
                "error": (
                    {"code": "RUNTIME_CONFIGURATION_REJECTED", "message": str(error)[:500]}
                    if state == "rejected" and error is not None
                    else None
                ),
            }
        )

    def _flush_acks(self, *, required: bool) -> None:
        if self.config.policy_api_key is None and self._pending_acks:
            raise ValueError("A policy API key is required to acknowledge Runtime Snapshot")
        while self._pending_acks:
            try:
                response = self._client.post(
                    self.config.runtime_acknowledgement_url,
                    headers={"authorization": f"Bearer {self.config.policy_api_key}"},
                    json=self._pending_acks[0],
                )
                response.raise_for_status()
                self._pending_acks.pop(0)
            except Exception as error:
                if required:
                    raise
                log_event(
                    logging.ERROR,
                    "RUNTIME_POLICY_ACK_FAILED",
                    {"error_type": type(error).__name__},
                )
                return

    def select_route(
        self,
        virtual_model: str,
        now: datetime | None = None,
        context: Mapping[str, object] | None = None,
    ) -> RouteSelection:
        with self._lock:
            snapshot = self._snapshot
        if snapshot is None:
            raise ValueError("No Runtime Snapshot is loaded")
        return select_runtime_route(snapshot, virtual_model, now or datetime.now(UTC), context)

    def apply_to_request(self, data: Mapping[str, object]) -> dict[str, object]:
        metadata_raw = data.get("metadata")
        metadata = dict(metadata_raw) if isinstance(metadata_raw, Mapping) else {}
        hint = metadata.get("cp_route")
        hinted_model = hint.get("virtual_model") if isinstance(hint, Mapping) else None
        virtual_model = hinted_model if isinstance(hinted_model, str) else data.get("model")
        if not isinstance(virtual_model, str):
            raise ValueError("Request does not name a virtual model")
        with self._lock:
            snapshot = self._snapshot
        if snapshot is None:
            if self.config.policy_required:
                raise RuntimeError("No trusted Runtime Snapshot is available")
            return dict(data)
        cp_value = metadata.get("cp")
        cp = dict(cp_value) if isinstance(cp_value, Mapping) else {}
        snapshot_value = snapshot.model_dump(mode="json", by_alias=True)
        access = snapshot_value.get("access")
        if isinstance(access, Mapping):
            if access.get("application_enabled") is not True:
                raise PermissionError("Model access denied: application_disabled")
            blocked = access.get("blocked_user_ids")
            if isinstance(blocked, list) and cp.get("user_id") in blocked:
                raise PermissionError("Model access denied: user_blocked")
        event_properties = cp.get("event_properties")
        event_values = event_properties if isinstance(event_properties, Mapping) else {}
        call_source = (
            cp.get("call_source") or event_values.get("call_source") or data.get("call_type")
        )
        route_context: dict[str, object] = {}
        if isinstance(cp.get("user_id"), str):
            route_context["user_id"] = cp["user_id"]
        if isinstance(cp.get("request_id"), str):
            route_context["selection_key"] = cp["request_id"]
        if isinstance(cp.get("user_properties"), Mapping):
            route_context["user_properties"] = dict(cp["user_properties"])
        if isinstance(call_source, str):
            route_context["call_source"] = call_source
        try:
            route = self.select_route(virtual_model, context=route_context)
        except ValueError:
            if not self.config.policy_required:
                return dict(data)
            raise
        # The Runtime Snapshot already chose the model and fallback order. Remove request
        # tags so LiteLLM's optional tag router cannot filter that decision a second time.
        # The trusted route identity remains in cp_route for usage attribution.
        metadata.pop("tags", None)
        aiu = snapshot_value.get("aiu")
        quota_mode = aiu.get("mode") if isinstance(aiu, Mapping) else "disabled"
        candidates = [route.primary, *route.fallbacks]
        candidate_model_ids = [
            candidate["model_id"]
            for candidate in candidates
            if isinstance(candidate.get("model_id"), str)
        ]
        cp.update(
            {
                "context_version": cp.get("context_version") or "1",
                "virtual_model": virtual_model,
                "model_id": str(route.primary["model_id"]),
                "model_tag": str(route.primary["model_tag"]),
                "configuration_version": str(route.configuration_version),
            }
        )
        metadata.update(
            {
                "virtual_model": virtual_model,
                "configuration_version": route.configuration_version,
                "route_tag": route.route_tag,
                "cp": cp,
                "cp_route": {
                    "virtual_model": virtual_model,
                    "route_tag": route.route_tag,
                    "model_id": route.primary["model_id"],
                    "model_tag": route.primary["model_tag"],
                    "candidate_model_ids": candidate_model_ids,
                    "candidate_models": [
                        {
                            "model_id": candidate["model_id"],
                            "model_tag": candidate["model_tag"],
                        }
                        for candidate in candidates
                    ],
                    "configuration_version": route.configuration_version,
                    "quota_mode": quota_mode,
                },
            }
        )
        output = dict(data)
        primary_model = str(route.primary["model_tag"])
        output["model"] = primary_model
        output["fallbacks"] = [
            {primary_model: [str(target["model_tag"]) for target in route.fallbacks]}
        ]
        output["metadata"] = metadata
        return output

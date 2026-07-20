"""Shared Runtime Snapshot LKG, signing, and fail-mode state."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from collections.abc import Callable, Mapping
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from ..errors import AiControlSdkError
from .context import ResolvedAiRuntimeContext
from .contracts import RuntimeRefreshResult, RuntimeSnapshot

RuntimeFailMode = Literal["fail_open", "fail_closed"]


def utc_string(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def verify_snapshot(
    snapshot: RuntimeSnapshot, now: datetime, *, allow_expired: bool
) -> RuntimeSnapshot:
    unsigned = snapshot.model_dump(
        mode="json", exclude={"etag", "signature"}, exclude_none=True, by_alias=True
    )
    expected = f"sha256:{hashlib.sha256(canonical_json(unsigned).encode()).hexdigest()}"
    if snapshot.etag != expected:
        raise AiControlSdkError(
            "SDK_RUNTIME_CHECKSUM_MISMATCH",
            "Runtime Snapshot ETag does not match its canonical content.",
        )
    binding = {"application_id": snapshot.application_id, "etag": snapshot.etag}
    expected_signature = f"sha256:{hashlib.sha256(canonical_json(binding).encode()).hexdigest()}"
    if snapshot.signature != expected_signature:
        raise AiControlSdkError(
            "SDK_RUNTIME_SIGNATURE_MISMATCH",
            "Runtime Snapshot signature does not match its application binding.",
        )
    if (
        not allow_expired
        and datetime.fromisoformat(snapshot.expires_at.replace("Z", "+00:00")) <= now
    ):
        raise AiControlSdkError(
            "SDK_RUNTIME_EXPIRED", "Control Plane returned an expired Runtime Snapshot."
        )
    return snapshot


def _atomic_write(path: Path, snapshot: RuntimeSnapshot) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            file.write(snapshot.model_dump_json(by_alias=True, exclude_none=True))
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary_name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except Exception:
        with suppress(FileNotFoundError):
            os.unlink(temporary_name)
        raise


def _governed(
    values: Mapping[str, str | int | bool], allowed: list[str], kind: str
) -> dict[str, str | int | bool]:
    allowed_keys = set(allowed)
    forbidden = sorted(set(values) - allowed_keys)
    if forbidden:
        raise AiControlSdkError(
            "SDK_DIMENSION_NOT_ALLOWED",
            f"{kind} dimension {forbidden[0]} is not allowed by the Runtime Snapshot.",
        )
    return dict(values)


class RuntimeState:
    def __init__(
        self,
        *,
        lkg_path: Path,
        fail_mode: RuntimeFailMode,
        now: Callable[[], datetime],
    ) -> None:
        self.lkg_path = lkg_path
        self.fail_mode = fail_mode
        self.now = now
        self.snapshot: RuntimeSnapshot | None = None
        self.source: Literal["remote", "lkg"] = "lkg"

    def load_lkg(self) -> bool:
        try:
            value = json.loads(self.lkg_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return False
        self.snapshot = verify_snapshot(
            RuntimeSnapshot.model_validate(value), self.now(), allow_expired=True
        )
        self.source = "lkg"
        return True

    def apply_remote(self, snapshot: RuntimeSnapshot) -> None:
        self.validate_remote(snapshot)
        self.commit_remote(snapshot)

    def validate_remote(self, snapshot: RuntimeSnapshot) -> None:
        verify_snapshot(snapshot, self.now(), allow_expired=False)
        if (
            self.snapshot is not None
            and snapshot.version == self.snapshot.version
            and snapshot.etag != self.snapshot.etag
        ):
            raise AiControlSdkError(
                "SDK_RUNTIME_VERSION_COLLISION",
                "Runtime Snapshot version was reused with another ETag.",
            )

    def commit_remote(self, snapshot: RuntimeSnapshot) -> None:
        _atomic_write(self.lkg_path, snapshot)
        self.snapshot = snapshot
        self.source = "remote"

    def validate_remote_current(self) -> None:
        verify_snapshot(self.require_snapshot(), self.now(), allow_expired=False)

    def result(self, status: Literal["updated", "not_modified", "lkg"]) -> RuntimeRefreshResult:
        snapshot = self.require_snapshot()
        return RuntimeRefreshResult(
            status=status,
            version=snapshot.version,
            etag=snapshot.etag,
            expired=self.expired(snapshot),
        )

    def expired(self, snapshot: RuntimeSnapshot | None = None) -> bool:
        value = snapshot or self.require_snapshot()
        return datetime.fromisoformat(value.expires_at.replace("Z", "+00:00")) <= self.now()

    def require_snapshot(self) -> RuntimeSnapshot:
        if self.snapshot is None:
            raise AiControlSdkError("SDK_RUNTIME_UNAVAILABLE", "No Runtime Snapshot is loaded.")
        return self.snapshot

    def require_usable_snapshot(self) -> RuntimeSnapshot:
        snapshot = self.require_snapshot()
        if self.expired(snapshot) and self.fail_mode == "fail_closed":
            raise AiControlSdkError("SDK_RUNTIME_EXPIRED", "Runtime Snapshot has expired.")
        return snapshot

    def metadata_envelope(self, context: ResolvedAiRuntimeContext) -> dict[str, Any]:
        snapshot = self.require_usable_snapshot()
        analytics = _governed(
            context.analytics_dimensions,
            snapshot.dimensions.analytics_allowed_keys,
            "analytics",
        )
        return {
            "context_version": snapshot.version,
            "operation_id": context.operation_id,
            "request_id": context.request_id,
            "trace_id": context.trace_id,
            "user_id": context.user_id,
            **({} if context.display_user is None else {"display_user": context.display_user}),
            **(
                {}
                if context.application_version is None
                else {"application_version": context.application_version}
            ),
            **(
                {}
                if context.parent_request_id is None
                else {"parent_request_id": context.parent_request_id}
            ),
            **({} if context.session_id is None else {"session_id": context.session_id}),
            **(
                {}
                if context.conversation_id is None
                else {"conversation_id": context.conversation_id}
            ),
            **(
                {}
                if not context.event_properties
                else {"event_properties": context.event_properties}
            ),
            **({} if not context.user_properties else {"user_properties": context.user_properties}),
            **({} if context.call_source is None else {"call_source": context.call_source}),
            **({} if not analytics else {"analytics_dimensions": analytics}),
        }

"""Current application configuration acknowledgements emitted by Python clients."""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import datetime
from typing import Any, Literal

from .context import new_ulid
from .contracts import (
    ETAG_PATTERN,
    UUID_PATTERN,
    RuntimeAcknowledgementError,
    RuntimeConfigurationAcknowledgement,
    RuntimeConnectorIdentity,
    RuntimeSnapshot,
)
from .state import utc_string

AcknowledgementState = Literal["received", "applied", "rejected"]


def _mapping(value: object) -> Mapping[str, Any] | None:
    return value if isinstance(value, Mapping) else None


def _configuration_reference(value: object) -> tuple[str, int, str] | None:
    raw: object = (
        value.model_dump(mode="json", by_alias=True)
        if isinstance(value, RuntimeSnapshot)
        else value
    )
    snapshot = _mapping(raw)
    plans = _mapping(snapshot.get("routing")) if snapshot is not None else None
    if plans is None:
        return None
    versions = {
        plan.get("configuration_version")
        for raw_plan in plans.values()
        if (plan := _mapping(raw_plan)) is not None
        and isinstance(plan.get("configuration_version"), int)
        and not isinstance(plan.get("configuration_version"), bool)
    }
    etag = snapshot.get("etag") if snapshot is not None else None
    application_id = snapshot.get("application_id") if snapshot is not None else None
    if (
        len(versions) != 1
        or not isinstance(application_id, str)
        or re.fullmatch(UUID_PATTERN, application_id) is None
        or not isinstance(etag, str)
        or re.fullmatch(ETAG_PATTERN, etag) is None
    ):
        return None
    version = next(iter(versions))
    return (application_id, version, etag) if isinstance(version, int) and version > 0 else None


def runtime_acknowledgements(
    value: object,
    state: AcknowledgementState,
    identity: RuntimeConnectorIdentity,
    now: datetime,
    error: Exception | None = None,
) -> list[RuntimeConfigurationAcknowledgement]:
    reference = _configuration_reference(value)
    if reference is None:
        return []
    application_id, version, etag = reference
    timestamp = utc_string(now)
    return [
        RuntimeConfigurationAcknowledgement(
            schema_version="2.0",
            application_id=application_id,
            acknowledgement_id=new_ulid().upper(),
            acknowledged_at=timestamp,
            connector=identity,
            configuration_version=version,
            configuration_etag=etag,
            state=state,
            applied_at=timestamp if state == "applied" else None,
            error=(
                RuntimeAcknowledgementError(
                    code="SDK_RUNTIME_SNAPSHOT_REJECTED",
                    message=str(error or "Runtime Snapshot was rejected")[:500],
                )
                if state == "rejected"
                else None
            ),
        )
    ]

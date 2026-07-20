"""Canonical batch construction and response disposition validation."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .contracts import CanonicalUsageBatch
from .identifiers import new_ulid
from .spool import SpoolEvent


class BatchItemResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    index: int = Field(ge=0)
    event_id: str | None
    status: Literal["accepted", "duplicate", "conflict", "rejected"]
    code: str | None = None
    message: str | None = None


class BatchResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal["2.0"]
    batch_id: str
    received_at: str
    accepted: int = Field(ge=0)
    duplicates: int = Field(ge=0)
    conflicts: int = Field(ge=0)
    rejected: int = Field(ge=0)
    results: list[BatchItemResponse]

    @model_validator(mode="after")
    def counts_match_results(self) -> BatchResponse:
        counts = {
            "accepted": self.accepted,
            "duplicate": self.duplicates,
            "conflict": self.conflicts,
            "rejected": self.rejected,
        }
        for status, expected in counts.items():
            if sum(item.status == status for item in self.results) != expected:
                raise ValueError(f"{status} count does not match results")
        if len({item.index for item in self.results}) != len(self.results):
            raise ValueError("response indexes must be unique")
        return self


def build_batch(events: list[SpoolEvent], now: datetime | None = None) -> dict[str, object]:
    moment = now or datetime.now(UTC)
    candidate = {
        "schema_version": "2.0",
        "batch_id": new_ulid(moment),
        "sent_at": moment.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "events": [event.payload for event in events],
    }
    return CanonicalUsageBatch.model_validate(candidate).model_dump(
        mode="json", by_alias=True, exclude_unset=True
    )


def response_dispositions(
    candidate: object,
    event_ids: list[str],
) -> tuple[list[str], list[tuple[str, str]]]:
    response = BatchResponse.model_validate(candidate)
    if len(response.results) != len(event_ids):
        raise ValueError("batch response result count mismatch")
    acknowledged: list[str] = []
    rejected: list[tuple[str, str]] = []
    for item in response.results:
        if item.index >= len(event_ids):
            raise ValueError("batch response index out of range")
        event_id = event_ids[item.index]
        if item.event_id is not None and item.event_id != event_id:
            raise ValueError("batch response event ID mismatch")
        if item.status in {"accepted", "duplicate"}:
            acknowledged.append(event_id)
        else:
            default_code = "PAYLOAD_HASH_CONFLICT" if item.status == "conflict" else "INVALID_EVENT"
            rejected.append((event_id, item.code or default_code))
    return acknowledged, rejected

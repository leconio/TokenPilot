"""Canonical connector heartbeat and usage contract models."""

from __future__ import annotations

from typing import Self

from pydantic import model_validator

from .generated import contracts as generated
from .validation.core import (
    _validate_dimension_map,
    _validate_model_timestamps,
    _validate_real_utc_timestamp,
    _validate_unique,
)
from .validation.domains import (
    _validate_route,
    _validate_usage_event_semantics,
    _validate_usage_line,
    _validate_usage_result,
)

ConnectorIdentity = generated.Connector
ConnectorCapabilities = generated.Capabilities


class CanonicalConnectorHeartbeat(generated.ConnectorHeartbeat):
    """Current connector health and durable-buffer state."""

    @model_validator(mode="after")
    def semantic_invariants_hold(self) -> Self:
        _validate_model_timestamps(self)
        _validate_real_utc_timestamp(self.sent_at)
        if self.last_successful_upload_at is not None:
            _validate_real_utc_timestamp(self.last_successful_upload_at)
        return self


class CanonicalUsageEvent(generated.UsageEvent):
    """Raw canonical usage with governed context and exclusive usage buckets."""

    @model_validator(mode="after")
    def semantic_invariants_hold(self) -> Self:
        _validate_usage_event_semantics(self)
        return self


class CanonicalUsageBatch(generated.UsageBatch):
    """A deduplicated batch of canonical usage events."""

    @model_validator(mode="after")
    def semantic_invariants_hold(self) -> Self:
        _validate_model_timestamps(self)
        for event in self.events:
            _validate_usage_event_semantics(event)
        _validate_unique([event.event_id for event in self.events], "expected unique event IDs")
        return self


class CanonicalNormalizedUsage(generated.NormalizedUsage):
    """Rating-ready canonical usage with mutually exclusive normalized lines."""

    @model_validator(mode="after")
    def semantic_invariants_hold(self) -> Self:
        _validate_model_timestamps(self)
        _validate_route(self.route)
        _validate_dimension_map(self.analytics_dimensions)
        _validate_usage_result(self.result)
        _validate_unique(
            self.normalization.missing_usage_fields,
            "expected unique missing usage fields",
        )
        _validate_unique(
            list(self.normalization.warnings),
            "expected unique normalization warnings",
        )
        line_identities = [_validate_usage_line(line) for line in self.usage_lines]
        _validate_unique(line_identities, "expected mutually exclusive usage lines")
        return self

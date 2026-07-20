"""Canonical machine, runtime configuration, and AIU reservation contracts."""

from __future__ import annotations

from typing import Self, cast

from pydantic import RootModel, model_validator

from .generated import contracts as generated
from .validation.core import (
    _enum_value,
    _optional,
    _validate_micro_fields,
    _validate_model_timestamps,
    _validate_nonnegative_int64,
    _validate_unique,
)


def _validate_runtime_route(route: generated.Default | generated.Route3) -> None:
    targets = cast(list[generated.Target | generated.Target1], route.targets)
    _validate_unique(
        [target.model_id for target in targets],
        "runtime route model IDs must be unique",
    )
    for index, target in enumerate(targets):
        if target.route_tag != route.route_tag:
            raise ValueError("runtime target route tag must match its route")
        if target.fallback_order != index:
            raise ValueError("runtime targets require contiguous fallback order")


def _validate_user_property_match(value: object) -> None:
    user_property = getattr(value, "user_property", None)
    if user_property is None:
        return
    operator = _enum_value(user_property.operator)
    if operator not in {"is_set", "is_not_set"} and _optional(user_property.value) is None:
        raise ValueError("a user property match requires a value")


class CanonicalBatchIngestionResponse(generated.BatchIngestionResponse):
    """Per-item ingestion dispositions with count and index invariants."""

    @model_validator(mode="after")
    def semantic_invariants_hold(self) -> Self:
        _validate_model_timestamps(self)
        expected = {
            "accepted": self.accepted,
            "duplicate": self.duplicates,
            "conflict": self.conflicts,
            "rejected": self.rejected,
        }
        for status, count in expected.items():
            actual = sum(_enum_value(item.status) == status for item in self.results)
            if actual != count:
                raise ValueError(f"{status} count does not match results")
        _validate_unique([item.index for item in self.results], "response indexes must be unique")
        return self


class CanonicalRuntimeConfigurationAcknowledgement(generated.RuntimeConfigurationAcknowledgement):
    """Application runtime configuration result reported by a connector."""

    @model_validator(mode="after")
    def semantic_invariants_hold(self) -> Self:
        _validate_model_timestamps(self)
        state = _enum_value(self.state)
        if state == "rejected" and self.error is None:
            raise ValueError("a rejected acknowledgement requires error details")
        if state == "applied" and self.applied_at is None:
            raise ValueError("an applied acknowledgement requires applied_at")
        if state != "applied" and self.applied_at is not None:
            raise ValueError("only an applied acknowledgement may include applied_at")
        if state != "rejected" and self.error is not None:
            raise ValueError("only a rejected acknowledgement may include error details")
        if self.applied_at is not None and self.applied_at > self.acknowledged_at:
            raise ValueError("applied_at cannot be later than acknowledged_at")
        return self


class CanonicalVirtualModelRouteMatch(RootModel[generated.VirtualModelRouteMatch]):
    """One stored virtual-model routing condition."""

    @model_validator(mode="after")
    def semantic_invariants_hold(self) -> Self:
        match = self.root
        _validate_user_property_match(match)
        schedule = getattr(match, "schedule", None)
        if schedule is not None:
            _validate_unique(schedule.days, "route schedule days must be unique")
        user = getattr(match, "user", None)
        if user is not None:
            _validate_unique(user.ids, "route user IDs must be unique")
        return self


class CanonicalRuntimeSnapshot(generated.RuntimeSnapshot):
    """ETag-addressed runtime configuration used by trusted connectors."""

    @model_validator(mode="after")
    def semantic_invariants_hold(self) -> Self:
        _validate_model_timestamps(self)
        mode = _enum_value(self.aiu.mode)
        if self.aiu.enabled == (mode == "disabled"):
            raise ValueError("AIU enabled and mode are inconsistent")
        _validate_unique(self.access.blocked_user_ids, "blocked user IDs must be unique")
        _validate_unique(
            self.dimensions.analytics_allowed_keys,
            "analytics dimension keys must be unique",
        )
        versions = {plan.configuration_version for plan in self.routing.values()}
        if len(versions) > 1:
            raise ValueError("all routing plans must use one configuration version")
        for plan in self.routing.values():
            _validate_unique([rule.id for rule in plan.rules], "runtime rule IDs must be unique")
            _validate_runtime_route(plan.default)
            for rule in plan.rules:
                _validate_runtime_route(rule.route)
                _validate_user_property_match(rule.match)
                if (
                    getattr(rule.match, "override_active", False)
                    and _optional(rule.expires_at) is None
                ):
                    raise ValueError("a runtime override rule requires expires_at")
                schedule = getattr(rule.match, "schedule", None)
                if schedule is not None:
                    _validate_unique(schedule.days, "runtime schedule days must be unique")
                user = getattr(rule.match, "user", None)
                if user is not None:
                    _validate_unique(user.ids, "runtime route user IDs must be unique")
        return self


class CanonicalRuntimeUserReservationRequest(generated.RuntimeUserReservationRequest):
    """Application-user AIU reservation request for candidate real models."""

    @model_validator(mode="after")
    def semantic_invariants_hold(self) -> Self:
        _validate_nonnegative_int64(self.estimated_aiu_micros)
        candidate_ids = _optional(self.candidate_model_ids)
        if candidate_ids is not None:
            _validate_unique(candidate_ids, "candidate model IDs must be unique")
        return self


class CanonicalRuntimeUserReservationResponse(generated.RuntimeUserReservationResponse):
    """AIU access decision and optional short-lived reservation."""

    @model_validator(mode="after")
    def semantic_invariants_hold(self) -> Self:
        _validate_micro_fields(self.user)
        if self.reservation is not None:
            _validate_micro_fields(self.reservation)
            _validate_model_timestamps(self.reservation)
        if not self.allowed and self.reservation is not None:
            raise ValueError("a denied request cannot include a reservation")
        return self


class CanonicalRuntimeUserReservationSettlement(generated.RuntimeUserReservationSettlement):
    """Final AIU amount applied to a prior reservation."""

    @model_validator(mode="after")
    def semantic_invariants_hold(self) -> Self:
        _validate_nonnegative_int64(self.settled_aiu_micros)
        return self


CanonicalApiError = generated.ApiError
CanonicalRuntimeUserReservationRelease = generated.RuntimeUserReservationRelease
CanonicalUsageConfidence = generated.UsageConfidence

__all__ = [
    "CanonicalApiError",
    "CanonicalBatchIngestionResponse",
    "CanonicalRuntimeConfigurationAcknowledgement",
    "CanonicalRuntimeSnapshot",
    "CanonicalRuntimeUserReservationRelease",
    "CanonicalRuntimeUserReservationRequest",
    "CanonicalRuntimeUserReservationResponse",
    "CanonicalRuntimeUserReservationSettlement",
    "CanonicalUsageConfidence",
    "CanonicalVirtualModelRouteMatch",
]

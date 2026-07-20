"""Public canonical Pydantic contracts with semantic validation."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Self
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import RootModel, model_validator

from .generated import contracts as generated
from .machine_contracts import (
    CanonicalApiError,
    CanonicalBatchIngestionResponse,
    CanonicalRuntimeConfigurationAcknowledgement,
    CanonicalRuntimeSnapshot,
    CanonicalRuntimeUserReservationRelease,
    CanonicalRuntimeUserReservationRequest,
    CanonicalRuntimeUserReservationResponse,
    CanonicalRuntimeUserReservationSettlement,
    CanonicalUsageConfidence,
    CanonicalVirtualModelRouteMatch,
)
from .usage_contracts import (
    CanonicalConnectorHeartbeat,
    CanonicalNormalizedUsage,
    CanonicalUsageBatch,
    CanonicalUsageEvent,
    ConnectorCapabilities,
    ConnectorIdentity,
)
from .validation.core import (
    _enum_value,
    _optional,
    _validate_dimension_map,
    _validate_model_timestamps,
    _validate_real_utc_timestamp,
    _validate_timestamp_order,
    _validate_unique,
)
from .validation.domains import (
    _validate_reconciliation_metrics,
    _validate_reconciliation_summary,
)


class AnalyticsDimensions(RootModel[generated.AnalyticsDimensions8]):
    """Custom fields used only for usage analysis and reports."""

    @model_validator(mode="after")
    def semantic_invariants_hold(self) -> Self:
        _validate_dimension_map(self.root)
        return self


class ReportQuery(generated.ReportQuery):
    """Saved-report compatible filters, grouping, and cursor pagination."""

    @model_validator(mode="after")
    def semantic_invariants_hold(self) -> Self:
        _validate_model_timestamps(self)
        _validate_timestamp_order(self.from_, self.to, "report range to must be later than from")
        start = datetime.fromisoformat(self.from_.replace("Z", "+00:00"))
        end = datetime.fromisoformat(self.to.replace("Z", "+00:00"))
        if (end - start).total_seconds() > 366 * 86_400:
            raise ValueError("report range cannot exceed 366 days")
        try:
            ZoneInfo(self.timezone)
        except ZoneInfoNotFoundError as error:
            raise ValueError("invalid report timezone") from error
        for condition in self.conditions:
            operator = _enum_value(condition.operator)
            count = len(condition.values)
            if operator in {"is_set", "is_not_set"} and count != 0:
                raise ValueError("this report operator has no value")
            if operator == "between" and count != 2:
                raise ValueError("between requires two report values")
            if operator not in {"is_set", "is_not_set", "between"} and count < 1:
                raise ValueError("a report filter value is required")
        group_property = _optional(self.group_property)
        if (_enum_value(self.group_dimension) == "property") != (group_property is not None):
            raise ValueError("custom field grouping requires the property dimension")
        return self


class ReportEnvelope(RootModel[generated.ReportEnvelope]):
    """Analytics response with its ClickHouse watermark and projection lag."""

    @model_validator(mode="after")
    def semantic_invariants_hold(self) -> Self:
        _validate_model_timestamps(self, allow_opaque_report_data=True)
        envelope = self.root
        if envelope.range is not None:
            _validate_timestamp_order(
                envelope.range.from_,
                envelope.range.to,
                "report range to must be later than from",
            )
        return self


class ReconciliationRun(generated.ReconciliationRun):
    """Bounded PostgreSQL-to-ClickHouse reconciliation run."""

    @model_validator(mode="after")
    def semantic_invariants_hold(self) -> Self:
        _validate_model_timestamps(self)
        _validate_timestamp_order(
            self.range_start, self.range_end, "range_end must be later than range_start"
        )
        _validate_reconciliation_summary(self.summary)
        status = _enum_value(self.status)
        if status == "running" and self.finished_at is not None:
            raise ValueError("a running reconciliation cannot have finished_at")
        if status in {"completed", "failed", "cancelled"} and self.finished_at is None:
            raise ValueError(f"{status} reconciliations require finished_at")
        if status == "failed" and self.error is None:
            raise ValueError("a failed reconciliation requires an error")
        return self


class ReconciliationDiff(generated.ReconciliationDiff):
    """Classified difference between authoritative and projected data."""

    @model_validator(mode="after")
    def semantic_invariants_hold(self) -> Self:
        _validate_model_timestamps(self)
        diff_type = _enum_value(self.diff_type)
        if diff_type == "WATERMARK_STALLED":
            if self.dimensions is not None:
                raise ValueError("WATERMARK_STALLED does not use aggregate dimensions")
            delta_payload = self.delta_values.model_dump(mode="python", exclude_unset=True)
            if self.pg_values is not None or self.ch_values is not None or delta_payload:
                raise ValueError("WATERMARK_STALLED uses watermark evidence instead of metric maps")
        else:
            if self.dimensions is None:
                raise ValueError("aggregate reconciliation differences require dimensions")
            _validate_real_utc_timestamp(self.dimensions.time_bucket)
            if self.pg_values is None and self.ch_values is None:
                raise ValueError("at least one source metric map is required")
        _validate_reconciliation_metrics(self.pg_values, signed=False)
        _validate_reconciliation_metrics(self.ch_values, signed=False)
        _validate_reconciliation_metrics(self.delta_values, signed=True)
        delta_provider_cost = _optional(self.delta_values.provider_cost)
        if delta_provider_cost is not None and re.fullmatch(r"-0(?:\.0+)?", delta_provider_cost):
            raise ValueError("negative zero is not canonical")
        _validate_unique(self.sample_event_ids, "expected unique sample event IDs")
        status = _enum_value(self.status)
        if status in {"resolved", "ignored"} and (
            self.resolution is None or self.resolved_at is None or self.resolved_by is None
        ):
            raise ValueError(f"{status} diffs require resolution, resolved_at, and resolved_by")
        return self


CanonicalUsageType = generated.UsageType

__all__ = [
    "AnalyticsDimensions",
    "CanonicalApiError",
    "CanonicalBatchIngestionResponse",
    "CanonicalConnectorHeartbeat",
    "CanonicalNormalizedUsage",
    "CanonicalRuntimeConfigurationAcknowledgement",
    "CanonicalRuntimeSnapshot",
    "CanonicalRuntimeUserReservationRelease",
    "CanonicalRuntimeUserReservationRequest",
    "CanonicalRuntimeUserReservationResponse",
    "CanonicalRuntimeUserReservationSettlement",
    "CanonicalUsageBatch",
    "CanonicalUsageConfidence",
    "CanonicalUsageEvent",
    "CanonicalUsageType",
    "CanonicalVirtualModelRouteMatch",
    "ConnectorCapabilities",
    "ConnectorIdentity",
    "ReconciliationDiff",
    "ReconciliationRun",
    "ReportEnvelope",
    "ReportQuery",
]

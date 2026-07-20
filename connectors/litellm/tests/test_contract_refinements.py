"""Focused tests for current semantic refinements not native to JSON Schema."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from ai_control_litellm.contracts import (
    AnalyticsDimensions,
    CanonicalRuntimeSnapshot,
    CanonicalRuntimeUserReservationRequest,
    CanonicalRuntimeUserReservationResponse,
    CanonicalRuntimeUserReservationSettlement,
    CanonicalVirtualModelRouteMatch,
    ReconciliationDiff,
    ReportEnvelope,
    ReportQuery,
)

FIXTURES = Path(__file__).parents[3] / "fixtures" / "contracts" / "current"


def load_fixture(relative_path: str) -> dict[str, Any]:
    value: object = json.loads((FIXTURES / relative_path).read_text(encoding="utf-8"))
    assert isinstance(value, dict)
    return value


def test_virtual_model_match_requires_a_value_for_value_operators() -> None:
    valid = load_fixture("valid/virtual-model-route-match.json")
    CanonicalVirtualModelRouteMatch.model_validate(valid)
    with pytest.raises(ValidationError):
        CanonicalVirtualModelRouteMatch.model_validate(
            load_fixture("invalid/virtual-model-route-match-missing-value.json")
        )


def test_runtime_snapshot_enforces_contiguous_fallback_order() -> None:
    CanonicalRuntimeSnapshot.model_validate(load_fixture("valid/runtime-snapshot.json"))
    with pytest.raises(ValidationError):
        CanonicalRuntimeSnapshot.model_validate(
            load_fixture("invalid/runtime-snapshot-invalid-fallback-order.json")
        )


def test_runtime_user_reservations_enforce_models_int64_and_denied_state() -> None:
    CanonicalRuntimeUserReservationRequest.model_validate(
        load_fixture("valid/runtime-user-reservation-request.json")
    )
    with pytest.raises(ValidationError):
        CanonicalRuntimeUserReservationRequest.model_validate(
            load_fixture("invalid/runtime-user-reservation-request-duplicate-models.json")
        )
    with pytest.raises(ValidationError):
        CanonicalRuntimeUserReservationSettlement.model_validate(
            load_fixture("invalid/runtime-user-reservation-settlement-overflow.json")
        )
    with pytest.raises(ValidationError):
        CanonicalRuntimeUserReservationResponse.model_validate(
            load_fixture("invalid/runtime-user-reservation-response-denied-with-reservation.json")
        )


def test_custom_dimensions_reject_system_and_surrogate_keys() -> None:
    with pytest.raises(ValidationError):
        AnalyticsDimensions.model_validate({"virtual_model": "shadow"})
    with pytest.raises(ValidationError):
        AnalyticsDimensions.model_validate({"team": "\ud800"})


def test_report_query_validates_range_and_report_data_stays_opaque() -> None:
    ReportQuery.model_validate(load_fixture("valid/report-query.json"))
    with pytest.raises(ValidationError):
        ReportQuery.model_validate(load_fixture("invalid/report-query-reversed-range.json"))

    payload = load_fixture("valid/report-envelope-analytics.json")
    payload["data"] = {"raw": "\ud800"}
    ReportEnvelope.model_validate(payload)


def test_resolved_reconciliation_requires_actor() -> None:
    payload = load_fixture("valid/reconciliation-diff.json")
    payload.update(
        {
            "status": "resolved",
            "resolution": "Projection replayed.",
            "resolved_at": "2026-07-16T01:05:00Z",
        }
    )
    with pytest.raises(ValidationError):
        ReconciliationDiff.model_validate(payload)

    payload["resolved_by"] = "operator_1"
    ReconciliationDiff.model_validate(payload)


def test_watermark_stalled_reconciliation_uses_no_aggregate_values() -> None:
    payload = load_fixture("valid/reconciliation-diff.json")
    payload.update(
        {
            "diff_type": "WATERMARK_STALLED",
            "dimensions": None,
            "pg_values": None,
            "ch_values": None,
            "delta_values": {},
        }
    )
    ReconciliationDiff.model_validate(payload)

    payload["pg_values"] = {"event_count": "1"}
    with pytest.raises(ValidationError):
        ReconciliationDiff.model_validate(payload)

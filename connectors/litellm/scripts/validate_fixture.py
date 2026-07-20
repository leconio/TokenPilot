"""Validate one current fixture and emit a stable machine-readable result."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from pydantic import BaseModel as PydanticBaseModel
from pydantic import TypeAdapter, ValidationError

from ai_control_litellm.contracts import (
    AnalyticsDimensions,
    CanonicalApiError,
    CanonicalBatchIngestionResponse,
    CanonicalConnectorHeartbeat,
    CanonicalNormalizedUsage,
    CanonicalRuntimeConfigurationAcknowledgement,
    CanonicalRuntimeSnapshot,
    CanonicalRuntimeUserReservationRelease,
    CanonicalRuntimeUserReservationRequest,
    CanonicalRuntimeUserReservationResponse,
    CanonicalRuntimeUserReservationSettlement,
    CanonicalUsageBatch,
    CanonicalUsageConfidence,
    CanonicalUsageEvent,
    CanonicalUsageType,
    CanonicalVirtualModelRouteMatch,
    ReconciliationDiff,
    ReconciliationRun,
    ReportEnvelope,
    ReportQuery,
)

MODEL_TYPES: dict[str, Any] = {
    "ConnectorHeartbeat": CanonicalConnectorHeartbeat,
    "BatchIngestionResponse": CanonicalBatchIngestionResponse,
    "ApiError": CanonicalApiError,
    "RuntimeConfigurationAcknowledgement": CanonicalRuntimeConfigurationAcknowledgement,
    "UsageEvent": CanonicalUsageEvent,
    "UsageBatch": CanonicalUsageBatch,
    "NormalizedUsage": CanonicalNormalizedUsage,
    "UsageType": CanonicalUsageType,
    "UsageConfidence": CanonicalUsageConfidence,
    "AnalyticsDimensions": AnalyticsDimensions,
    "VirtualModelRouteMatch": CanonicalVirtualModelRouteMatch,
    "RuntimeSnapshot": CanonicalRuntimeSnapshot,
    "RuntimeUserReservationRequest": CanonicalRuntimeUserReservationRequest,
    "RuntimeUserReservationResponse": CanonicalRuntimeUserReservationResponse,
    "RuntimeUserReservationSettlement": CanonicalRuntimeUserReservationSettlement,
    "RuntimeUserReservationRelease": CanonicalRuntimeUserReservationRelease,
    "ReportQuery": ReportQuery,
    "ReportEnvelope": ReportEnvelope,
    "ReconciliationRun": ReconciliationRun,
    "ReconciliationDiff": ReconciliationDiff,
}


def validate(contract_name: str, fixture_path: Path) -> dict[str, Any]:
    payload: object = json.loads(fixture_path.read_text(encoding="utf-8"))
    model_type = MODEL_TYPES[contract_name]
    try:
        if isinstance(model_type, type) and issubclass(model_type, PydanticBaseModel):
            model = model_type.model_validate(payload)
            value = model.model_dump(
                mode="json",
                by_alias=True,
                # Zod materializes ReportQuery defaults in its parsed result. Keep those
                # defaults in the Python parity value while preserving absent optional
                # fields through the generated MISSING sentinel.
                exclude_unset=contract_name != "ReportQuery",
            )
        else:
            adapter = TypeAdapter(model_type)
            parsed = adapter.validate_python(payload)
            value = adapter.dump_python(parsed, mode="json")
    except ValidationError:
        return {"valid": False}
    return {"valid": True, "value": value}


def validate_batch(payload: object) -> list[dict[str, Any]]:
    if not isinstance(payload, list):
        raise ValueError("batch input must be a JSON array")
    results: list[dict[str, Any]] = []
    for item in payload:
        if not isinstance(item, dict):
            raise ValueError("each batch item must be an object")
        contract_name = item.get("contract")
        fixture_path = item.get("fixture")
        if not isinstance(contract_name, str) or contract_name not in MODEL_TYPES:
            raise ValueError("each batch item requires a known contract")
        if not isinstance(fixture_path, str):
            raise ValueError("each batch item requires a fixture path")
        results.append(validate(contract_name, Path(fixture_path)))
    return results


def main() -> None:
    if sys.argv[1:] == ["--batch"]:
        payload: object = json.loads(sys.stdin.read())
        print(json.dumps(validate_batch(payload), separators=(",", ":"), sort_keys=True))
        return
    if len(sys.argv) != 3 or sys.argv[1] not in MODEL_TYPES:
        raise SystemExit(
            "usage: validate_fixture.py <contract-name> <fixture-path> | --batch < cases.json"
        )
    result = validate(sys.argv[1], Path(sys.argv[2]))
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()

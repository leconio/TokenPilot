"""LiteLLM connector and current TokenPilot machine contracts."""

from .callback import AiControlLiteLLMCallback, proxy_handler_instance
from .contracts import (
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
    ConnectorCapabilities,
    ConnectorIdentity,
    ReconciliationDiff,
    ReconciliationRun,
    ReportEnvelope,
    ReportQuery,
)
from .runtime_policy import RouteSelection, RuntimePolicyClient

# Package-level convenience alias. Proxy config loads the config-local shim instead.
callback = proxy_handler_instance

__all__ = [
    "AiControlLiteLLMCallback",
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
    "RouteSelection",
    "RuntimePolicyClient",
    "callback",
    "proxy_handler_instance",
]

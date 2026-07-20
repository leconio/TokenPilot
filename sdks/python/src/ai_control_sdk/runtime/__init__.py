"""Canonical trusted runtime client surface."""

from .async_client import AsyncAiRuntimeClient
from .chat import (
    AiChatAttempt,
    AiChatResult,
    AsyncProviderAdapter,
    AsyncProviderChatStreamResponse,
    ChatMessage,
    ProviderChatRequest,
    ProviderChatResponse,
    ProviderChatStreamResponse,
    ProviderStreamPart,
    SyncProviderAdapter,
)
from .client import AiRuntimeClient
from .context import (
    AiRuntimeContext,
    ResolvedAiRuntimeContext,
    ai_context,
    async_ai_context,
    current_ai_context,
    require_ai_context,
)
from .contracts import (
    RuntimeConfigurationAcknowledgement,
    RuntimeRefreshResult,
    RuntimeSnapshot,
    RuntimeUserReservation,
    RuntimeUserReservationRequest,
    RuntimeUserReservationResponse,
    SdkReservationResult,
)
from .manual_usage import RecordUsageInput
from .openai import apply_ai_context_to_openai_request, sanitize_caller_tags
from .reservation import async_with_aiu_reservation, with_aiu_reservation
from .routing import RuntimeRouteContext, RuntimeRouteSelection, resolve_runtime_route

__all__ = [
    "AiChatAttempt",
    "AiChatResult",
    "AiRuntimeClient",
    "AiRuntimeContext",
    "AsyncAiRuntimeClient",
    "AsyncProviderAdapter",
    "AsyncProviderChatStreamResponse",
    "ChatMessage",
    "ProviderChatRequest",
    "ProviderChatResponse",
    "ProviderChatStreamResponse",
    "ProviderStreamPart",
    "RecordUsageInput",
    "ResolvedAiRuntimeContext",
    "RuntimeConfigurationAcknowledgement",
    "RuntimeRefreshResult",
    "RuntimeRouteContext",
    "RuntimeRouteSelection",
    "RuntimeSnapshot",
    "RuntimeUserReservation",
    "RuntimeUserReservationRequest",
    "RuntimeUserReservationResponse",
    "SdkReservationResult",
    "SyncProviderAdapter",
    "ai_context",
    "apply_ai_context_to_openai_request",
    "async_ai_context",
    "async_with_aiu_reservation",
    "current_ai_context",
    "require_ai_context",
    "resolve_runtime_route",
    "sanitize_caller_tags",
    "with_aiu_reservation",
]

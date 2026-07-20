"""Strict current Runtime Snapshot and application-user AIU contracts."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ETAG_PATTERN = r"^sha256:[0-9a-f]{64}$"
VIRTUAL_MODEL_PATTERN = r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$"
SEMVER_PATTERN = r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$"
ULID_PATTERN = r"^[0-9A-HJKMNP-TV-Z]{26}$"
UTC_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$")
OPAQUE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$")
DIMENSION_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
PROPERTY_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9._-]{0,127}$")
MICRO_AIU_PATTERN = re.compile(r"^(?:0|[1-9][0-9]*)$")
UUID_PATTERN = (
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-"
    r"[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


def parse_utc(value: str) -> datetime:
    if not UTC_PATTERN.fullmatch(value):
        raise ValueError("Expected an RFC3339 UTC timestamp ending in Z")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("Expected a real calendar timestamp") from error


DimensionScalar = str | int | bool
DimensionMap = dict[str, DimensionScalar]
PropertyValue = str | int | float | bool | list[str]
PropertyMap = dict[str, PropertyValue]


def _unique(values: list[str], message: str) -> list[str]:
    if len(values) != len(set(values)):
        raise ValueError(message)
    return values


class RuntimeAiuSettings(StrictModel):
    enabled: bool
    mode: Literal["disabled", "observe", "soft_limit", "hard_limit", "unknown"]
    unrated_model_policy: Literal[
        "allow_unrated", "block_unrated", "fallback_required", "alert_only"
    ]


class RuntimeDimensionSettings(StrictModel):
    analytics_allowed_keys: list[Annotated[str, Field(pattern=DIMENSION_KEY_PATTERN.pattern)]]

    @field_validator("analytics_allowed_keys")
    @classmethod
    def keys_are_unique(cls, value: list[str]) -> list[str]:
        return _unique(value, "expected unique governed dimension keys")


class RuntimeCallConnection(StrictModel):
    id: Annotated[str, Field(pattern=OPAQUE_ID_PATTERN.pattern)]
    name: Annotated[str, Field(min_length=1, max_length=120)]
    driver: Literal["litellm", "openai_compatible", "anthropic"]
    base_url: Annotated[str, Field(min_length=1, max_length=2_048)] | None
    credential_ref: Annotated[str, Field(min_length=1, max_length=256)] | None
    timeout_ms: Annotated[int, Field(gt=0, le=600_000)]
    max_retries: Annotated[int, Field(ge=0, le=10)]
    api_version: Annotated[str, Field(min_length=1, max_length=64)] | None = None

    @model_validator(mode="after")
    def connection_is_consistent(self) -> RuntimeCallConnection:
        if self.driver != "anthropic" and self.base_url is None:
            raise ValueError("an OpenAI-compatible connection requires base_url")
        if self.base_url is not None:
            parsed = re.fullmatch(r"https?://[^\s/#]+(?:/[^\s#]*)?", self.base_url)
            if parsed is None or "@" in self.base_url.split("//", 1)[1].split("/", 1)[0]:
                raise ValueError("expected an HTTP(S) base URL without credentials or fragments")
        if self.credential_ref is not None and (
            any(character.isspace() for character in self.credential_ref)
            or any(
                ord(character) < 32 or ord(character) == 127 for character in self.credential_ref
            )
        ):
            raise ValueError("credential_ref cannot contain whitespace or control characters")
        return self


class RuntimeRouteTarget(StrictModel):
    model_id: Annotated[str, Field(pattern=OPAQUE_ID_PATTERN.pattern)]
    connection_id: Annotated[str, Field(pattern=OPAQUE_ID_PATTERN.pattern)]
    request_model: Annotated[str, Field(min_length=1, max_length=256)]
    provider: Annotated[str, Field(min_length=1, max_length=120)]
    task_type: Literal["chat", "embedding", "image", "audio"]
    capabilities: list[
        Literal[
            "streaming",
            "tools",
            "structured_output",
            "image_input",
            "audio_input",
            "audio_output",
            "cache_metering",
            "reasoning",
        ]
    ]
    route_tag: Annotated[str, Field(pattern=r"^cp:[a-z0-9._:-]+$")]
    fallback_order: Annotated[int, Field(ge=0, le=63)]
    weight: Annotated[int | float, Field(gt=0, le=1_000)]


class RuntimeRoute(StrictModel):
    route_tag: Annotated[str, Field(pattern=r"^cp:[a-z0-9._:-]+$")]
    selection_mode: Literal["ordered", "weighted"]
    targets: Annotated[list[RuntimeRouteTarget], Field(min_length=1, max_length=64)]

    @model_validator(mode="after")
    def targets_are_ordered(self) -> RuntimeRoute:
        if len({target.model_id for target in self.targets}) != len(self.targets):
            raise ValueError("expected unique model IDs within a route")
        for index, target in enumerate(self.targets):
            if target.route_tag != self.route_tag or target.fallback_order != index:
                raise ValueError("route targets must match their contiguous fallback order")
        return self


class RuntimeSchedule(StrictModel):
    days: Annotated[list[Annotated[int, Field(ge=1, le=7)]], Field(min_length=1, max_length=7)]
    from_: Annotated[str, Field(alias="from", pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")]
    to: Annotated[str, Field(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")]

    @field_validator("days")
    @classmethod
    def days_are_unique(cls, value: list[int]) -> list[int]:
        if len(value) != len(set(value)):
            raise ValueError("schedule days must be unique")
        return value


class RuntimeOverrideMatch(StrictModel):
    override_active: Literal[True]


class RuntimeScheduleMatch(StrictModel):
    schedule: RuntimeSchedule


class RuntimeUserMatchValue(StrictModel):
    ids: Annotated[
        list[Annotated[str, Field(min_length=1, max_length=256)]],
        Field(max_length=50_000),
    ]


class RuntimeUserMatch(StrictModel):
    user: RuntimeUserMatchValue


class RuntimeUserPropertyMatchValue(StrictModel):
    key: Annotated[str, Field(pattern=PROPERTY_KEY_PATTERN.pattern)]
    operator: Literal["equals", "not_equals", "contains", "starts_with", "is_set", "is_not_set"]
    value: str | int | float | bool | None = None

    @model_validator(mode="after")
    def value_matches_operator(self) -> RuntimeUserPropertyMatchValue:
        if self.operator not in {"is_set", "is_not_set"} and self.value is None:
            raise ValueError("the user property condition requires a value")
        return self


class RuntimeUserPropertyMatch(StrictModel):
    user_property: RuntimeUserPropertyMatchValue


class RuntimeCallSourceValue(StrictModel):
    value: Annotated[str, Field(min_length=1, max_length=120)]


class RuntimeCallSourceMatch(StrictModel):
    call_source: RuntimeCallSourceValue


RuntimeRuleMatch = (
    RuntimeOverrideMatch
    | RuntimeScheduleMatch
    | RuntimeUserMatch
    | RuntimeUserPropertyMatch
    | RuntimeCallSourceMatch
)


class RuntimeRoutingRule(StrictModel):
    id: Annotated[str, Field(min_length=1, max_length=120)]
    priority: int
    match: RuntimeRuleMatch
    route: RuntimeRoute
    expires_at: str | None = None

    @model_validator(mode="after")
    def rule_is_consistent(self) -> RuntimeRoutingRule:
        if isinstance(self.match, RuntimeOverrideMatch) and self.expires_at is None:
            raise ValueError("an override rule requires expires_at")
        if self.expires_at is not None:
            parse_utc(self.expires_at)
        return self


class RuntimeRoutingPlan(StrictModel):
    virtual_model_id: Annotated[str, Field(pattern=OPAQUE_ID_PATTERN.pattern)]
    configuration_version: Annotated[int, Field(gt=0)]
    configuration_etag: Annotated[str, Field(pattern=ETAG_PATTERN)]
    published_at: str
    timezone: Annotated[str, Field(min_length=1, max_length=128)]
    default: RuntimeRoute
    rules: Annotated[list[RuntimeRoutingRule], Field(max_length=512)]

    @model_validator(mode="after")
    def plan_is_consistent(self) -> RuntimeRoutingPlan:
        parse_utc(self.published_at)
        if len({rule.id for rule in self.rules}) != len(self.rules):
            raise ValueError("rule IDs must be unique")
        return self


class RuntimeAccess(StrictModel):
    application_enabled: bool
    blocked_user_ids: Annotated[list[str], Field(max_length=50_000)]

    @field_validator("blocked_user_ids")
    @classmethod
    def user_ids_are_unique(cls, value: list[str]) -> list[str]:
        return _unique(value, "blocked user IDs must be unique")


class RuntimeSnapshot(StrictModel):
    schema_version: Literal["2.0"]
    application_id: Annotated[str, Field(pattern=UUID_PATTERN)]
    version: Annotated[str, Field(pattern=OPAQUE_ID_PATTERN.pattern)]
    etag: Annotated[str, Field(pattern=ETAG_PATTERN)]
    signature: Annotated[str, Field(pattern=ETAG_PATTERN)]
    expires_at: str
    connections: dict[
        Annotated[str, Field(pattern=OPAQUE_ID_PATTERN.pattern)], RuntimeCallConnection
    ]
    routing: dict[Annotated[str, Field(pattern=VIRTUAL_MODEL_PATTERN)], RuntimeRoutingPlan]
    aiu: RuntimeAiuSettings
    access: RuntimeAccess
    dimensions: RuntimeDimensionSettings

    @model_validator(mode="after")
    def state_is_consistent(self) -> RuntimeSnapshot:
        parse_utc(self.expires_at)
        if self.aiu.enabled == (self.aiu.mode == "disabled"):
            raise ValueError("AIU enabled and mode are inconsistent")
        versions = {plan.configuration_version for plan in self.routing.values()}
        if len(versions) > 1:
            raise ValueError("all routing plans must belong to one configuration version")
        for connection_id, connection in self.connections.items():
            if connection.id != connection_id:
                raise ValueError("connection record key must match its ID")
        targets = [
            target
            for plan in self.routing.values()
            for route in (plan.default, *(rule.route for rule in plan.rules))
            for target in route.targets
        ]
        if any(target.connection_id not in self.connections for target in targets):
            raise ValueError("route target references an unknown connection")
        return self


class RuntimeConnectorIdentity(StrictModel):
    instance_id: Annotated[str, Field(min_length=1, max_length=256)]
    name: Literal["python"]
    version: Annotated[str, Field(pattern=SEMVER_PATTERN)]


class RuntimeAcknowledgementError(StrictModel):
    code: Annotated[str, Field(pattern=r"^[A-Z][A-Z0-9_]*$", max_length=120)]
    message: Annotated[str, Field(min_length=1, max_length=500)]


class RuntimeConfigurationAcknowledgement(StrictModel):
    schema_version: Literal["2.0"]
    application_id: Annotated[str, Field(pattern=UUID_PATTERN)]
    acknowledgement_id: Annotated[str, Field(pattern=ULID_PATTERN)]
    acknowledged_at: str
    connector: RuntimeConnectorIdentity
    configuration_version: Annotated[int, Field(gt=0)]
    configuration_etag: Annotated[str, Field(pattern=ETAG_PATTERN)]
    state: Literal["received", "applied", "rejected"]
    applied_at: str | None
    error: RuntimeAcknowledgementError | None

    @model_validator(mode="after")
    def acknowledgement_is_consistent(self) -> RuntimeConfigurationAcknowledgement:
        parse_utc(self.acknowledged_at)
        if self.applied_at is not None:
            parse_utc(self.applied_at)
        if self.state == "applied" and self.applied_at is None:
            raise ValueError("an applied acknowledgement requires applied_at")
        if self.state != "applied" and self.applied_at is not None:
            raise ValueError("only an applied acknowledgement may include applied_at")
        if self.state == "rejected" and self.error is None:
            raise ValueError("a rejected acknowledgement requires error")
        if self.state != "rejected" and self.error is not None:
            raise ValueError("only a rejected acknowledgement may include error")
        return self


class RuntimeUserReservationRequest(StrictModel):
    user_id: Annotated[str, Field(min_length=1, max_length=256)]
    display_user: Annotated[str, Field(min_length=1, max_length=256)] | None = None
    user_properties: PropertyMap | None = None
    operation_id: Annotated[str, Field(pattern=OPAQUE_ID_PATTERN.pattern)]
    virtual_model: Annotated[str, Field(pattern=VIRTUAL_MODEL_PATTERN)]
    candidate_model_ids: (
        Annotated[
            list[Annotated[str, Field(pattern=UUID_PATTERN)]],
            Field(min_length=1, max_length=32),
        ]
        | None
    ) = None
    estimated_aiu_micros: Annotated[str, Field(pattern=MICRO_AIU_PATTERN.pattern)]

    @field_validator("candidate_model_ids")
    @classmethod
    def candidates_are_unique(cls, value: list[str] | None) -> list[str] | None:
        return None if value is None else _unique(value, "expected unique candidate model IDs")


class RuntimeUserQuotaSummary(StrictModel):
    id: Annotated[str, Field(pattern=OPAQUE_ID_PATTERN.pattern)]
    limit_aiu_micros: Annotated[str, Field(pattern=MICRO_AIU_PATTERN.pattern)] | None
    used_aiu_micros: Annotated[str, Field(pattern=MICRO_AIU_PATTERN.pattern)]
    reserved_aiu_micros: Annotated[str, Field(pattern=MICRO_AIU_PATTERN.pattern)]
    remaining_aiu_micros: Annotated[str, Field(pattern=MICRO_AIU_PATTERN.pattern)] | None


class RuntimeUserReservation(StrictModel):
    id: Annotated[str, Field(pattern=OPAQUE_ID_PATTERN.pattern)]
    token: Annotated[str, Field(min_length=64, max_length=4096)]
    reserved_aiu_micros: Annotated[str, Field(pattern=MICRO_AIU_PATTERN.pattern)]
    expires_at: str

    @field_validator("expires_at")
    @classmethod
    def expiry_is_utc(cls, value: str) -> str:
        parse_utc(value)
        return value


class RuntimeUserReservationResponse(StrictModel):
    allowed: bool
    reason: Annotated[str, Field(min_length=1, max_length=120)]
    user: RuntimeUserQuotaSummary
    reservation: RuntimeUserReservation | None


class RuntimeRefreshResult(StrictModel):
    status: Literal["updated", "not_modified", "lkg"]
    version: str
    etag: str
    expired: bool


class SdkReservationResult(StrictModel):
    status: Literal["not_required", "allowed", "reserved", "fail_open"]
    network_used: bool
    token: RuntimeUserReservation | None
    response: RuntimeUserReservationResponse | None = None


JsonObject = dict[str, Any]

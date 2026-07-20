"""Deterministic current Runtime Snapshot route selection."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field

from ..errors import AiControlSdkError
from .contracts import (
    RuntimeCallSourceMatch,
    RuntimeOverrideMatch,
    RuntimeRoute,
    RuntimeRouteTarget,
    RuntimeRoutingPlan,
    RuntimeRoutingRule,
    RuntimeScheduleMatch,
    RuntimeSnapshot,
    RuntimeUserMatch,
    RuntimeUserPropertyMatch,
    parse_utc,
)


class RuntimeRouteContext(BaseModel):
    model_config = ConfigDict(frozen=True, strict=True)

    user_id: str | None = None
    user_properties: dict[str, Any] = Field(default_factory=dict)
    call_source: str | None = None
    selection_key: str | None = None


class RuntimeRouteSelection(BaseModel):
    model_config = ConfigDict(frozen=True, strict=True)

    virtual_model: str
    virtual_model_id: str
    configuration_version: int
    configuration_etag: str
    route_tag: str
    rule_id: str | None
    primary: RuntimeRouteTarget
    fallbacks: tuple[RuntimeRouteTarget, ...]


def _minute(value: str) -> int:
    return int(value[:2]) * 60 + int(value[3:])


def _property_matches(rule: RuntimeUserPropertyMatch, context: RuntimeRouteContext) -> bool:
    condition = rule.user_property
    current = context.user_properties.get(condition.key)
    if condition.operator == "is_set":
        return current is not None
    if condition.operator == "is_not_set":
        return current is None
    if condition.operator == "equals":
        return current == condition.value
    if condition.operator == "not_equals":
        return current != condition.value
    if condition.operator == "starts_with":
        return isinstance(current, str) and current.startswith(str(condition.value))
    if isinstance(current, str):
        return str(condition.value) in current
    return isinstance(current, list) and condition.value in current


def _schedule_matches(rule: RuntimeScheduleMatch, instant: datetime, timezone: str) -> bool:
    try:
        local = instant.astimezone(ZoneInfo(timezone))
    except ZoneInfoNotFoundError as error:
        raise AiControlSdkError(
            "SDK_RUNTIME_TIMEZONE_INVALID", "Cannot evaluate route timezone."
        ) from error
    schedule = rule.schedule
    start, end = _minute(schedule.from_), _minute(schedule.to)
    weekday, minute = local.isoweekday(), local.hour * 60 + local.minute
    if start < end:
        return weekday in schedule.days and start <= minute < end
    if start > end:
        previous = 7 if weekday == 1 else weekday - 1
        return (weekday in schedule.days and minute >= start) or (
            previous in schedule.days and minute < end
        )
    return False


def _matches(
    rule: RuntimeRoutingRule,
    instant: datetime,
    plan: RuntimeRoutingPlan,
    context: RuntimeRouteContext,
) -> bool:
    if isinstance(rule.match, RuntimeOverrideMatch):
        return rule.expires_at is not None and parse_utc(rule.expires_at) > instant
    if isinstance(rule.match, RuntimeUserMatch):
        return context.user_id in rule.match.user.ids
    if isinstance(rule.match, RuntimeUserPropertyMatch):
        return _property_matches(rule.match, context)
    if isinstance(rule.match, RuntimeCallSourceMatch):
        return context.call_source == rule.match.call_source.value
    if isinstance(rule.match, RuntimeScheduleMatch):
        return _schedule_matches(rule.match, instant, plan.timezone)
    return False


def _selection(
    virtual_model: str,
    plan: RuntimeRoutingPlan,
    route: RuntimeRoute,
    rule_id: str | None,
    context: RuntimeRouteContext,
) -> RuntimeRouteSelection:
    targets = _ordered_targets(route, context.selection_key or context.user_id)
    return RuntimeRouteSelection(
        virtual_model=virtual_model,
        virtual_model_id=plan.virtual_model_id,
        configuration_version=plan.configuration_version,
        configuration_etag=plan.configuration_etag,
        route_tag=route.route_tag,
        rule_id=rule_id,
        primary=targets[0],
        fallbacks=tuple(targets[1:]),
    )


def _deterministic_fraction(value: str) -> float:
    hash_value = 2_166_136_261
    for byte in value.encode("utf-8"):
        hash_value ^= byte
        hash_value = (hash_value * 16_777_619) & 0xFFFFFFFF
    return hash_value / 4_294_967_296


def _ordered_targets(
    route: RuntimeRoute, selection_key: str | None
) -> tuple[RuntimeRouteTarget, ...]:
    targets = tuple(route.targets)
    if route.selection_mode != "weighted" or selection_key is None:
        return targets
    point = _deterministic_fraction(f"{route.route_tag}:{selection_key}") * sum(
        target.weight for target in targets
    )
    cumulative = 0.0
    selected = targets[0]
    for target in targets:
        cumulative += target.weight
        if point < cumulative:
            selected = target
            break
    return (selected, *(target for target in targets if target.model_id != selected.model_id))


def resolve_runtime_route(
    snapshot: RuntimeSnapshot,
    virtual_model: str,
    instant: datetime,
    context: RuntimeRouteContext | None = None,
) -> RuntimeRouteSelection:
    plan = snapshot.routing.get(virtual_model)
    if plan is None:
        raise AiControlSdkError(
            "SDK_RUNTIME_ROUTE_NOT_FOUND",
            f"No active route is published for virtual model {virtual_model}.",
        )
    route_context = context or RuntimeRouteContext()
    matched = [rule for rule in plan.rules if _matches(rule, instant, plan, route_context)]
    if not matched:
        return _selection(virtual_model, plan, plan.default, None, route_context)
    highest = max(rule.priority for rule in matched)
    winners = [rule for rule in matched if rule.priority == highest]
    if len(winners) != 1:
        raise AiControlSdkError(
            "SDK_RUNTIME_ROUTE_CONFLICT",
            f"Multiple route rules share the winning priority for {virtual_model}.",
        )
    winner = winners[0]
    return _selection(virtual_model, plan, winner.route, winner.id, route_context)

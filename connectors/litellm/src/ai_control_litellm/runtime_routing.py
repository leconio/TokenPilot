"""Pure Runtime Snapshot route matching and selection."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .machine_contracts import CanonicalRuntimeSnapshot


@dataclass(frozen=True, slots=True)
class RouteSelection:
    virtual_model: str
    configuration_version: int
    configuration_etag: str
    route_tag: str
    rule_id: str | None
    primary: Mapping[str, object]
    fallbacks: tuple[Mapping[str, object], ...]


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _minute(value: str) -> int:
    return int(value[:2]) * 60 + int(value[3:])


def _json_scalar_equal(left: object, right: object) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left is right
    if isinstance(left, int | float) and isinstance(right, int | float):
        return left == right
    return type(left) is type(right) and left == right


def _javascript_string(value: object) -> str:
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "undefined"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _deterministic_fraction(value: str) -> float:
    hash_value = 2_166_136_261
    for byte in value.encode("utf-8"):
        hash_value ^= byte
        hash_value = (hash_value * 16_777_619) & 0xFFFFFFFF
    return hash_value / 4_294_967_296


def _ordered_targets(
    route: Mapping[str, object], targets: list[Mapping[str, object]], context: Mapping[str, object]
) -> list[Mapping[str, object]]:
    selection_key = context.get("selection_key") or context.get("user_id")
    if route.get("selection_mode") != "weighted" or not isinstance(selection_key, str):
        return targets
    weights: list[float] = []
    for target in targets:
        weight = target.get("weight")
        if isinstance(weight, bool) or not isinstance(weight, int | float):
            raise ValueError("Weighted route target is missing a valid weight")
        weights.append(float(weight))
    total = sum(weights)
    point = _deterministic_fraction(f"{route.get('route_tag')}:{selection_key}") * total
    cumulative = 0.0
    selected = targets[0]
    for target, weight in zip(targets, weights, strict=True):
        cumulative += weight
        if point < cumulative:
            selected = target
            break
    return [
        selected,
        *(target for target in targets if target.get("model_id") != selected.get("model_id")),
    ]


def _property_matches(condition: Mapping[str, object], context: Mapping[str, object]) -> bool:
    properties = context.get("user_properties")
    values = properties if isinstance(properties, Mapping) else {}
    key, operator = condition.get("key"), condition.get("operator")
    if not isinstance(key, str) or not isinstance(operator, str):
        return False
    current = values.get(key)
    if operator == "is_set":
        return current is not None
    if operator == "is_not_set":
        return current is None
    expected = condition.get("value")
    if operator == "equals":
        return _json_scalar_equal(current, expected)
    if operator == "not_equals":
        return not _json_scalar_equal(current, expected)
    if operator == "starts_with":
        expected_text = _javascript_string(expected)
        return (
            isinstance(current, str) and expected_text != "" and current.startswith(expected_text)
        )
    if operator == "contains":
        if isinstance(current, str):
            return _javascript_string(expected) in current
        return isinstance(current, list) and any(
            _json_scalar_equal(item, expected) for item in current
        )
    return False


def _matches(
    rule: Mapping[str, object],
    timezone: str,
    now: datetime,
    context: Mapping[str, object],
) -> bool:
    match = rule.get("match")
    if not isinstance(match, Mapping):
        return False
    if match.get("override_active") is True:
        expiry = rule.get("expires_at")
        return isinstance(expiry, str) and _parse_time(expiry) > now
    user = match.get("user")
    if isinstance(user, Mapping):
        ids = user.get("ids")
        return isinstance(ids, list) and context.get("user_id") in ids
    user_property = match.get("user_property")
    if isinstance(user_property, Mapping):
        return _property_matches(user_property, context)
    call_source = match.get("call_source")
    if isinstance(call_source, Mapping):
        return context.get("call_source") == call_source.get("value")
    schedule = match.get("schedule")
    if not isinstance(schedule, Mapping):
        return False
    try:
        local = now.astimezone(ZoneInfo(timezone))
    except ZoneInfoNotFoundError as error:
        raise ValueError("Runtime route timezone is invalid") from error
    days = schedule.get("days")
    start_value = schedule.get("from")
    end_value = schedule.get("to")
    if (
        not isinstance(days, list)
        or not isinstance(start_value, str)
        or not isinstance(end_value, str)
    ):
        return False
    start, end = _minute(start_value), _minute(end_value)
    weekday, minute = local.isoweekday(), local.hour * 60 + local.minute
    if start < end:
        return weekday in days and start <= minute < end
    if start > end:
        previous = 7 if weekday == 1 else weekday - 1
        return (weekday in days and minute >= start) or (previous in days and minute < end)
    return False


def select_runtime_route(
    snapshot: CanonicalRuntimeSnapshot,
    virtual_model: str,
    now: datetime,
    context: Mapping[str, object] | None = None,
) -> RouteSelection:
    raw = snapshot.model_dump(mode="json", by_alias=True)
    routing = raw["routing"]
    plan = routing.get(virtual_model) if isinstance(routing, dict) else None
    if not isinstance(plan, Mapping):
        raise ValueError(f"No active route for virtual model {virtual_model}")
    rules = plan.get("rules")
    iterable = rules if isinstance(rules, list) else []
    matched = [
        rule
        for rule in iterable
        if isinstance(rule, Mapping)
        if _matches(rule, str(plan["timezone"]), now, context or {})
    ]
    rule_id: str | None = None
    route = plan.get("default")
    if matched:
        highest = max(int(rule["priority"]) for rule in matched)
        winners = [rule for rule in matched if int(rule["priority"]) == highest]
        if len(winners) != 1:
            raise ValueError(f"Conflicting route rules for virtual model {virtual_model}")
        route = winners[0].get("route")
        rule_id = str(winners[0]["id"])
    if not isinstance(route, Mapping) or not isinstance(route.get("targets"), list):
        raise ValueError("Selected route has no targets")
    targets = [target for target in route["targets"] if isinstance(target, Mapping)]
    if not targets:
        raise ValueError("Selected route has no targets")
    targets = _ordered_targets(route, targets, context or {})
    return RouteSelection(
        virtual_model=virtual_model,
        configuration_version=int(plan["configuration_version"]),
        configuration_etag=str(plan["configuration_etag"]),
        route_tag=str(route["route_tag"]),
        rule_id=rule_id,
        primary=targets[0],
        fallbacks=tuple(targets[1:]),
    )

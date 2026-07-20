import type { RuntimeRoute, RuntimeRouteTarget, RuntimeSnapshot } from "@tokenpilot/contracts";

import { AiControlSdkError } from "../errors.js";

export interface RuntimeRouteSelection {
  readonly virtualModel: string;
  readonly virtualModelId: string;
  readonly configurationVersion: number;
  readonly configurationEtag: string;
  readonly routeTag: string;
  readonly ruleId: string | null;
  readonly primary: RuntimeRouteTarget;
  readonly fallbacks: readonly RuntimeRouteTarget[];
}

export interface RuntimeRouteContext {
  readonly userId?: string;
  readonly userProperties?: Readonly<Record<string, unknown>>;
  readonly callSource?: string;
  readonly selectionKey?: string;
}

const weekdayNumbers: Readonly<Record<string, number>> = Object.freeze({
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
});

function localized(now: Date, timezone: string): { weekday: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = weekdayNumbers[value.weekday ?? ""];
  if (weekday === undefined) {
    throw new AiControlSdkError("SDK_RUNTIME_TIMEZONE_INVALID", "Cannot evaluate route timezone.");
  }
  return { weekday, minute: Number(value.hour) * 60 + Number(value.minute) };
}

function clockMinute(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

function previousWeekday(value: number): number {
  return value === 1 ? 7 : value - 1;
}

function ruleMatches(
  rule: RuntimeSnapshot["routing"][string]["rules"][number],
  local: { weekday: number; minute: number },
  now: Date,
  context: RuntimeRouteContext,
): boolean {
  if ("override_active" in rule.match) {
    return rule.expires_at !== undefined && new Date(rule.expires_at).getTime() > now.getTime();
  }
  if ("user" in rule.match) return rule.match.user.ids.includes(context.userId ?? "");
  if ("user_property" in rule.match) {
    const condition = rule.match.user_property;
    const value = context.userProperties?.[condition.key];
    if (condition.operator === "is_set") return value !== undefined && value !== null;
    if (condition.operator === "is_not_set") return value === undefined || value === null;
    if (condition.operator === "equals") return value === condition.value;
    if (condition.operator === "not_equals") return value !== condition.value;
    if (condition.operator === "starts_with") {
      return typeof value === "string" && value.startsWith(String(condition.value));
    }
    if (typeof value === "string") return value.includes(String(condition.value));
    return Array.isArray(value) && value.includes(condition.value);
  }
  if ("call_source" in rule.match) return context.callSource === rule.match.call_source.value;
  if (!("schedule" in rule.match)) return false;
  const schedule = rule.match.schedule;
  const start = clockMinute(schedule.from);
  const end = clockMinute(schedule.to);
  if (start < end) {
    return schedule.days.includes(local.weekday) && local.minute >= start && local.minute < end;
  }
  if (start > end) {
    return (
      (schedule.days.includes(local.weekday) && local.minute >= start) ||
      (schedule.days.includes(previousWeekday(local.weekday)) && local.minute < end)
    );
  }
  return false;
}

function selection(
  virtualModel: string,
  plan: RuntimeSnapshot["routing"][string],
  route: RuntimeRoute,
  ruleId: string | null,
  context: RuntimeRouteContext,
): RuntimeRouteSelection {
  const targets = orderedTargets(route, context.selectionKey ?? context.userId);
  const [primary, ...fallbacks] = targets;
  if (primary === undefined) {
    throw new AiControlSdkError("SDK_RUNTIME_ROUTE_EMPTY", "Selected runtime route has no target.");
  }
  return Object.freeze({
    virtualModel,
    virtualModelId: plan.virtual_model_id,
    configurationVersion: plan.configuration_version,
    configurationEtag: plan.configuration_etag,
    routeTag: route.route_tag,
    ruleId,
    primary: Object.freeze({ ...primary }),
    fallbacks: Object.freeze(fallbacks.map((target) => Object.freeze({ ...target }))),
  });
}

function deterministicFraction(value: string): number {
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 4_294_967_296;
}

function orderedTargets(
  route: RuntimeRoute,
  selectionKey: string | undefined,
): readonly RuntimeRouteTarget[] {
  if (route.selection_mode !== "weighted" || selectionKey === undefined) return route.targets;
  const total = route.targets.reduce((sum, target) => sum + target.weight, 0);
  const point = deterministicFraction(`${route.route_tag}:${selectionKey}`) * total;
  let cumulative = 0;
  let selected = route.targets[0]!;
  for (const target of route.targets) {
    cumulative += target.weight;
    if (point < cumulative) {
      selected = target;
      break;
    }
  }
  return [selected, ...route.targets.filter((target) => target.model_id !== selected.model_id)];
}

export function resolveRuntimeRoute(
  snapshot: RuntimeSnapshot,
  virtualModel: string,
  now: Date,
  context: RuntimeRouteContext = {},
): RuntimeRouteSelection {
  const plan = snapshot.routing[virtualModel];
  if (plan === undefined) {
    throw new AiControlSdkError(
      "SDK_RUNTIME_ROUTE_NOT_FOUND",
      `No active route is published for virtual model ${virtualModel}.`,
    );
  }
  const local = localized(now, plan.timezone);
  const matched = plan.rules.filter((rule) => ruleMatches(rule, local, now, context));
  if (matched.length === 0) return selection(virtualModel, plan, plan.default, null, context);
  const highest = Math.max(...matched.map((rule) => rule.priority));
  const winners = matched.filter((rule) => rule.priority === highest);
  if (winners.length !== 1) {
    throw new AiControlSdkError(
      "SDK_RUNTIME_ROUTE_CONFLICT",
      `Multiple route rules share the winning priority for ${virtualModel}.`,
    );
  }
  const winner = winners[0]!;
  return selection(virtualModel, plan, winner.route, winner.id, context);
}

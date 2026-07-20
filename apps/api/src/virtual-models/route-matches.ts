import {
  runtimeRouteMatchSchema,
  virtualModelRouteMatchSchema,
  type VirtualModelRouteMatch,
  type RuntimeRoutingRule,
} from "@tokenpilot/contracts";
import type { DatabaseClient } from "@tokenpilot/db";

export interface RouteAudienceUser {
  readonly externalId: string;
  readonly tags: readonly string[];
  readonly status: "ACTIVE" | "BLOCKED";
  readonly quota: {
    readonly enabled: boolean;
    readonly hardLimit: boolean;
    readonly limitAiuMicros: bigint;
    readonly consumedAiuMicros: bigint;
    readonly reservedAiuMicros: bigint;
  } | null;
}

export interface RouteAudience {
  readonly users: readonly RouteAudienceUser[];
  readonly groups: ReadonlyMap<string, readonly string[]>;
}

export interface RouteRequestContext {
  readonly userId?: string | undefined;
  readonly userProperties?: Readonly<Record<string, unknown>> | undefined;
  readonly callSource?: string | undefined;
}

export async function loadRouteAudience(
  database: DatabaseClient,
  applicationId: string,
): Promise<RouteAudience> {
  const [users, groups] = await Promise.all([
    database.applicationUser.findMany({
      where: { applicationId },
      select: {
        externalId: true,
        tags: true,
        status: true,
        quota: {
          select: {
            enabled: true,
            hardLimit: true,
            limitAiuMicros: true,
            consumedAiuMicros: true,
            reservedAiuMicros: true,
          },
        },
      },
      orderBy: { externalId: "asc" },
    }),
    database.applicationUserGroup.findMany({
      where: { applicationId, enabled: true },
      select: {
        id: true,
        definitionVersion: true,
        evaluations: {
          orderBy: { evaluatedAt: "desc" },
          take: 1,
          select: {
            definitionVersion: true,
            members: {
              orderBy: { user: { externalId: "asc" } },
              select: { user: { select: { externalId: true } } },
            },
          },
        },
      },
    }),
  ]);
  return {
    users,
    groups: new Map(
      groups.flatMap((group) => {
        const latest = group.evaluations[0];
        if (latest === undefined || latest.definitionVersion !== group.definitionVersion) return [];
        return [[group.id, latest.members.map((member) => member.user.externalId)] as const];
      }),
    ),
  };
}

type StoredMatch = VirtualModelRouteMatch;
type RuntimeMatch = RuntimeRoutingRule["match"];

function aiuState(user: RouteAudienceUser): "available" | "low" | "exhausted" | "unlimited" {
  const quota = user.quota;
  if (quota === null || !quota.enabled || !quota.hardLimit) return "unlimited";
  const remaining = quota.limitAiuMicros - quota.consumedAiuMicros - quota.reservedAiuMicros;
  if (remaining <= 0n) return "exhausted";
  if (quota.limitAiuMicros > 0n && remaining * 5n <= quota.limitAiuMicros) return "low";
  return "available";
}

export function resolveRuntimeMatch(value: unknown, audience: RouteAudience): RuntimeMatch {
  const match = virtualModelRouteMatchSchema.parse(value) as StoredMatch;
  const direct = runtimeRouteMatchSchema.safeParse(match);
  if (direct.success) return direct.data;
  if ("user_group" in match) {
    const ids = audience.groups.get(match.user_group.group_id);
    if (ids === undefined)
      throw new TypeError("Route condition references an unevaluated user group");
    return { user: { ids: [...ids] } };
  }
  if ("user_tag" in match) {
    return {
      user: {
        ids: audience.users
          .filter((user) => user.tags.includes(match.user_tag.value))
          .map((user) => user.externalId),
      },
    };
  }
  if (!("aiu_state" in match)) throw new TypeError("Unsupported route condition");
  return {
    user: {
      ids: audience.users
        .filter((user) => aiuState(user) === match.aiu_state.value)
        .map((user) => user.externalId),
    },
  };
}

const weekdayNumber: Readonly<Record<string, number>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

function localClock(instant: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    day: weekdayNumber[value.weekday ?? ""] ?? 0,
    minute: Number(value.hour) * 60 + Number(value.minute),
  };
}

function clockMinute(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

function scheduleMatches(
  schedule: { readonly days: readonly number[]; readonly from: string; readonly to: string },
  instant: Date,
  timezone: string,
): boolean {
  const local = localClock(instant, timezone);
  const start = clockMinute(schedule.from);
  const end = clockMinute(schedule.to);
  if (start < end) {
    return schedule.days.includes(local.day) && local.minute >= start && local.minute < end;
  }
  if (start > end) {
    const previousDay = local.day === 1 ? 7 : local.day - 1;
    return (
      (schedule.days.includes(local.day) && local.minute >= start) ||
      (schedule.days.includes(previousDay) && local.minute < end)
    );
  }
  return false;
}

function propertyMatches(
  condition: Extract<RuntimeMatch, { user_property: unknown }>["user_property"],
  properties: Readonly<Record<string, unknown>>,
): boolean {
  const current = properties[condition.key];
  if (condition.operator === "is_set") return current !== undefined && current !== null;
  if (condition.operator === "is_not_set") return current === undefined || current === null;
  if (condition.operator === "equals") return current === condition.value;
  if (condition.operator === "not_equals") return current !== condition.value;
  if (condition.operator === "starts_with") {
    return (
      typeof current === "string" &&
      String(condition.value) !== "" &&
      current.startsWith(String(condition.value))
    );
  }
  if (typeof current === "string") return current.includes(String(condition.value));
  return Array.isArray(current) && current.includes(condition.value);
}

export function runtimeMatchApplies(
  value: unknown,
  instant: Date,
  timezone: string,
  context: RouteRequestContext = {},
): boolean {
  const parsed = runtimeRouteMatchSchema.safeParse(value);
  if (!parsed.success) return false;
  const match = parsed.data;
  if ("override_active" in match) return true;
  if ("schedule" in match) return scheduleMatches(match.schedule, instant, timezone);
  if ("user" in match)
    return context.userId !== undefined && match.user.ids.includes(context.userId);
  if ("call_source" in match) return context.callSource === match.call_source.value;
  return propertyMatches(match.user_property, context.userProperties ?? {});
}

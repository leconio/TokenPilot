import { BadRequestException } from "@nestjs/common";

import {
  reportQuerySchema,
  reportStaticQueryKeys,
  type ReportFilterCondition,
  type ReportGroupDimension,
  type ReportMetric,
  type ReportPropertyGroup,
  type ReportTimeGrain,
} from "@tokenpilot/contracts";
import type { PropertyDataType } from "@tokenpilot/db";

export type ResolvedReportFilterCondition = ReportFilterCondition & {
  readonly dataType?: PropertyDataType;
  readonly userIds?: readonly string[];
};

export interface ReportQuery {
  readonly applicationId: string;
  readonly from: Date;
  readonly to: Date;
  readonly timezone: string;
  readonly pageSize: number;
  readonly usageCursor: UsageCursor | null;
  readonly groupCursor: GroupCursor | null;
  readonly filterMatch: "all" | "any";
  readonly filters: readonly ResolvedReportFilterCondition[];
  readonly metric: ReportMetric;
  readonly grain: ReportTimeGrain;
  readonly groupDimension: ReportGroupDimension;
  readonly groupProperty?: ReportPropertyGroup & { readonly dataType?: PropertyDataType };
  readonly knownUsageTotal?: number;
}

export interface UsageCursor {
  readonly eventTime: string;
  readonly eventId: string;
  readonly position: number;
}

export interface GroupCursor {
  readonly kind: "provider_cost" | "aiu" | "activity";
  readonly dimension: string;
  readonly groupKey: string;
  readonly secondaryKey: string;
  readonly position: number;
}

export type ReportPagination = "none" | "usage" | GroupCursor["kind"];
const knownKeys = new Set<string>(reportStaticQueryKeys);

function text(query: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const candidate = query[key];
  return typeof candidate === "string" && candidate !== "" ? candidate : undefined;
}

function integer(query: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const candidate = text(query, key);
  if (candidate === undefined || !/^[1-9][0-9]*$/u.test(candidate)) return undefined;
  const parsed = Number(candidate);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function filterConditions(value: unknown): unknown {
  if (value === undefined || value === "") return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") throw new BadRequestException("Invalid report conditions");
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new BadRequestException("Invalid report conditions");
  }
}

function jsonValue(value: unknown, label: string): unknown {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new BadRequestException(`Invalid ${label}`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new BadRequestException(`Invalid ${label}`);
  }
}

function badCursor(): never {
  throw new BadRequestException("Invalid report cursor");
}

function cursorPayload(value: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,16384}$/u.test(value)) return badCursor();
  try {
    const payload: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      return payload as Record<string, unknown>;
    }
  } catch {
    // The common error below intentionally hides cursor internals.
  }
  return badCursor();
}

export function decodeUsageCursor(value: string): UsageCursor {
  const cursor = cursorPayload(value);
  const instant = typeof cursor.t === "string" ? new Date(cursor.t) : null;
  if (
    cursor.v !== 1 ||
    cursor.k !== "usage" ||
    typeof cursor.t !== "string" ||
    instant === null ||
    !Number.isFinite(instant.getTime()) ||
    instant.toISOString() !== cursor.t ||
    typeof cursor.e !== "string" ||
    cursor.e.length < 1 ||
    cursor.e.length > 256 ||
    !Number.isSafeInteger(cursor.p) ||
    Number(cursor.p) < 1
  ) {
    return badCursor();
  }
  return { eventTime: cursor.t, eventId: cursor.e, position: Number(cursor.p) };
}

export function encodeUsageCursor(cursor: UsageCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      k: "usage",
      t: cursor.eventTime,
      e: cursor.eventId,
      p: cursor.position,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeGroupCursor(
  value: string,
  kind: GroupCursor["kind"],
  dimension: string,
): GroupCursor {
  const cursor = cursorPayload(value);
  if (
    cursor.v !== 1 ||
    cursor.k !== kind ||
    cursor.d !== dimension ||
    typeof cursor.g !== "string" ||
    cursor.g.length > 2_048 ||
    typeof cursor.s !== "string" ||
    cursor.s.length > 64 ||
    !Number.isSafeInteger(cursor.p) ||
    Number(cursor.p) < 1
  ) {
    return badCursor();
  }
  return {
    kind,
    dimension,
    groupKey: cursor.g,
    secondaryKey: cursor.s,
    position: Number(cursor.p),
  };
}

export function encodeGroupCursor(cursor: GroupCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      k: cursor.kind,
      d: cursor.dimension,
      g: cursor.groupKey,
      s: cursor.secondaryKey,
      p: cursor.position,
    }),
    "utf8",
  ).toString("base64url");
}

export function groupCursorDimension(
  query: Pick<ReportQuery, "groupDimension" | "groupProperty">,
): string {
  return query.groupDimension === "property" && query.groupProperty !== undefined
    ? `property:${query.groupProperty.scope}:${query.groupProperty.key}`
    : query.groupDimension;
}

export function parseReportQuery(
  query: Readonly<Record<string, unknown>>,
  now: Date = new Date(),
  pagination: ReportPagination = "none",
  applicationId = "00000000-0000-0000-0000-000000000000",
): ReportQuery {
  for (const key of Object.keys(query)) {
    if (!knownKeys.has(key)) throw new BadRequestException(`Unsupported report filter ${key}`);
  }
  if (pagination === "none" && query.cursor !== undefined) {
    throw new BadRequestException("This report does not use cursor pagination");
  }
  const to = text(query, "to") ?? now.toISOString();
  const parsedTo = new Date(to);
  const fallbackFrom = Number.isFinite(parsedTo.getTime())
    ? new Date(parsedTo.getTime() - 86_400_000).toISOString()
    : now.toISOString();
  const result = reportQuerySchema.safeParse({
    from: text(query, "from") ?? fallbackFrom,
    to,
    timezone: text(query, "timezone") ?? "UTC",
    cursor: text(query, "cursor"),
    page_size: integer(query, "page_size") ?? (query.page_size === undefined ? 50 : Number.NaN),
    filter_match: text(query, "filter_match") ?? "all",
    conditions: filterConditions(query.conditions),
    metric: text(query, "metric") ?? "requests",
    grain: text(query, "grain") ?? "day",
    group_dimension: text(query, "group_dimension") ?? "model_tag",
    group_property: jsonValue(query.group_property, "report group field"),
  });
  if (!result.success) {
    throw new BadRequestException(result.error.issues[0]?.message ?? "Invalid report query");
  }
  const parsed = result.data;
  return {
    applicationId,
    from: new Date(parsed.from),
    to: new Date(parsed.to),
    timezone: parsed.timezone,
    pageSize: parsed.page_size,
    usageCursor:
      parsed.cursor === undefined || pagination !== "usage"
        ? null
        : decodeUsageCursor(parsed.cursor),
    groupCursor:
      parsed.cursor === undefined || pagination === "none" || pagination === "usage"
        ? null
        : decodeGroupCursor(
            parsed.cursor,
            pagination,
            parsed.group_dimension === "property" && parsed.group_property !== undefined
              ? `property:${parsed.group_property.scope}:${parsed.group_property.key}`
              : parsed.group_dimension,
          ),
    filterMatch: parsed.filter_match,
    filters: parsed.conditions,
    metric: parsed.metric,
    grain: parsed.grain,
    groupDimension: parsed.group_dimension,
    ...(parsed.group_property === undefined ? {} : { groupProperty: parsed.group_property }),
  };
}

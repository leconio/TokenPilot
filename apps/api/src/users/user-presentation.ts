import { Prisma, QuotaPeriodType } from "@tokenpilot/db";

import type { ApplicationUserMetrics } from "./user-metrics.repository.js";

export const userQuotaPeriodTypes = {
  day: QuotaPeriodType.CALENDAR_DAY,
  week: QuotaPeriodType.CALENDAR_WEEK,
  month: QuotaPeriodType.CALENDAR_MONTH,
  lifetime: QuotaPeriodType.LIFETIME,
  fixed: QuotaPeriodType.FIXED_WINDOW,
} as const;

export function aiuToMicros(value: string): bigint {
  return BigInt(new Prisma.Decimal(value).mul(1_000_000).toFixed(0));
}

function presentPeriod(type: QuotaPeriodType | undefined): string {
  if (type === QuotaPeriodType.CALENDAR_DAY) return "day";
  if (type === QuotaPeriodType.CALENDAR_WEEK) return "week";
  if (type === QuotaPeriodType.CALENDAR_MONTH) return "month";
  if (type === QuotaPeriodType.FIXED_WINDOW) return "fixed";
  return "lifetime";
}

type UserRow = Prisma.ApplicationUserGetPayload<{ include: { quota: true } }>;

export function presentApplicationUser(row: UserRow, metrics?: ApplicationUserMetrics) {
  const quota = row.quota;
  const limit = quota?.limitAiuMicros ?? 0n;
  const used = quota?.consumedAiuMicros ?? 0n;
  const reserved = quota?.reservedAiuMicros ?? 0n;
  return {
    id: row.id,
    user_id: row.externalId,
    display_user: row.name,
    tags: row.tags,
    properties: row.propertiesJson,
    status: row.status.toLowerCase(),
    blocked_reason: row.blockedReason,
    first_seen_at: row.firstSeenAt.toISOString(),
    last_seen_at: row.lastSeenAt.toISOString(),
    usage: {
      calls: metrics?.calls ?? 0,
      tokens: metrics?.tokens.toString() ?? "0",
      aiu_micros: (metrics?.aiuMicros ?? 0n).toString(),
    },
    quota: {
      limit_aiu_micros: limit.toString(),
      used_aiu_micros: used.toString(),
      reserved_aiu_micros: reserved.toString(),
      remaining_aiu_micros: (limit - used - reserved).toString(),
      hard_limit: quota?.hardLimit ?? false,
      period: presentPeriod(quota?.periodType),
      period_start: quota?.periodStart.toISOString() ?? null,
      period_end: quota?.periodEnd?.toISOString() ?? null,
    },
  };
}

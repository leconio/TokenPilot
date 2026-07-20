import { randomUUID } from "node:crypto";

import {
  AiuLedgerEntryType,
  AiuQuotaPolicyScope,
  AiuReservationStatus,
  QuotaPeriodType,
} from "./generated/prisma/enums.js";
import type { Prisma } from "./generated/prisma/client.js";

export type AiuQuotaPolicyDatabase = Pick<
  Prisma.TransactionClient,
  | "aiuQuotaPolicy"
  | "applicationUserGroup"
  | "userAiuQuota"
  | "userAiuReservation"
  | "userAiuLedgerEntry"
>;

export interface EffectiveAiuQuotaPolicy {
  readonly id: string;
  readonly applicationId: string;
  readonly scope: AiuQuotaPolicyScope;
  readonly limitAiuMicros: bigint;
  readonly hardLimit: boolean;
  readonly periodType:
    "CALENDAR_DAY" | "CALENDAR_WEEK" | "CALENDAR_MONTH" | "FIXED_WINDOW" | "LIFETIME" | "UNKNOWN";
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly updatedAt: Date;
}

export async function resolveEffectiveAiuQuotaPolicy(
  database: AiuQuotaPolicyDatabase,
  applicationId: string,
  userId: string,
): Promise<EffectiveAiuQuotaPolicy | null> {
  const policies = await database.aiuQuotaPolicy.findMany({
    where: {
      applicationId,
      enabled: true,
      OR: [
        { scope: AiuQuotaPolicyScope.USER, userId },
        { scope: AiuQuotaPolicyScope.USER_GROUP },
        { scope: AiuQuotaPolicyScope.APPLICATION },
      ],
    },
    include: {
      userGroup: {
        select: {
          definitionVersion: true,
          evaluations: {
            orderBy: { evaluatedAt: "desc" },
            take: 1,
            select: {
              definitionVersion: true,
              members: { where: { userId }, select: { userId: true }, take: 1 },
            },
          },
        },
      },
    },
    orderBy: [{ priority: "desc" }, { updatedAt: "desc" }, { id: "asc" }],
  });
  const direct = policies.find((policy) => policy.scope === AiuQuotaPolicyScope.USER);
  if (direct !== undefined) return direct;
  const group = policies.find((policy) => {
    if (policy.scope !== AiuQuotaPolicyScope.USER_GROUP || policy.userGroup === null) return false;
    const evaluation = policy.userGroup.evaluations[0];
    return (
      evaluation !== undefined &&
      evaluation.definitionVersion === policy.userGroup.definitionVersion &&
      evaluation.members.length === 1
    );
  });
  return (
    group ?? policies.find((policy) => policy.scope === AiuQuotaPolicyScope.APPLICATION) ?? null
  );
}

export interface QuotaPeriodWindowValue {
  readonly start: Date;
  readonly end: Date | null;
}

interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function localDate(instant: Date, timezone: string): LocalDate {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return { year: values.year!, month: values.month!, day: values.day! };
}

function localMidnight(date: LocalDate, timezone: string): Date {
  const target = Date.UTC(date.year, date.month - 1, date.day);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .formatToParts(new Date(candidate))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const represented = Date.UTC(
      parts.year!,
      parts.month! - 1,
      parts.day!,
      parts.hour!,
      parts.minute!,
      parts.second!,
    );
    candidate += target - represented;
  }
  return new Date(candidate);
}

function addDays(date: LocalDate, days: number): LocalDate {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

export function aiuQuotaPeriodWindow(
  type: QuotaPeriodType,
  timezone: string,
  now: Date,
  fixed?: Readonly<{ start: Date; end: Date }>,
): QuotaPeriodWindowValue {
  if (type === QuotaPeriodType.LIFETIME) return { start: now, end: null };
  if (type === QuotaPeriodType.FIXED_WINDOW) {
    if (fixed === undefined || fixed.start >= fixed.end)
      throw new TypeError("Invalid fixed AIU window");
    return fixed;
  }
  let startDate = localDate(now, timezone);
  if (type === QuotaPeriodType.CALENDAR_WEEK) {
    const weekday = new Date(
      Date.UTC(startDate.year, startDate.month - 1, startDate.day),
    ).getUTCDay();
    startDate = addDays(startDate, -((weekday + 6) % 7));
  } else if (type === QuotaPeriodType.CALENDAR_MONTH) {
    startDate = { ...startDate, day: 1 };
  }
  const endDate =
    type === QuotaPeriodType.CALENDAR_DAY
      ? addDays(startDate, 1)
      : type === QuotaPeriodType.CALENDAR_WEEK
        ? addDays(startDate, 7)
        : startDate.month === 12
          ? { year: startDate.year + 1, month: 1, day: 1 }
          : { year: startDate.year, month: startDate.month + 1, day: 1 };
  return { start: localMidnight(startDate, timezone), end: localMidnight(endDate, timezone) };
}

/** Materializes the effective policy into the user's authoritative quota and ledger. */
export async function materializeEffectiveAiuQuotaPolicy(
  database: AiuQuotaPolicyDatabase,
  input: {
    readonly applicationId: string;
    readonly userId: string;
    readonly window: (policy: EffectiveAiuQuotaPolicy) => QuotaPeriodWindowValue;
    readonly reason: string;
  },
) {
  const [policy, current] = await Promise.all([
    resolveEffectiveAiuQuotaPolicy(database, input.applicationId, input.userId),
    database.userAiuQuota.findUnique({
      where: {
        applicationId_userId: {
          applicationId: input.applicationId,
          userId: input.userId,
        },
      },
    }),
  ]);
  if (policy === null) {
    if (current === null || current.policyId === null || !current.enabled) return current;
    const updated = await database.userAiuQuota.update({
      where: { id: current.id },
      data: { policyId: null, enabled: false, lockVersion: { increment: 1 } },
    });
    await database.userAiuLedgerEntry.create({
      data: {
        applicationId: input.applicationId,
        userId: input.userId,
        quotaId: current.id,
        entryType: AiuLedgerEntryType.GRANT,
        consumedAfterMicros: current.consumedAiuMicros,
        reservedAfterMicros: current.reservedAiuMicros,
        limitAfterMicros: current.limitAiuMicros,
        idempotencyKey: `quota-policy:none:${input.userId}:${randomUUID()}`,
        reason: input.reason,
      },
    });
    return updated;
  }
  const window = input.window(policy);
  if (current === null) {
    const created = await database.userAiuQuota.create({
      data: {
        applicationId: input.applicationId,
        userId: input.userId,
        policyId: policy.id,
        periodType: policy.periodType,
        periodStart: window.start,
        periodEnd: window.end,
        limitAiuMicros: policy.limitAiuMicros,
        hardLimit: policy.hardLimit,
      },
    });
    await database.userAiuLedgerEntry.create({
      data: {
        applicationId: input.applicationId,
        userId: input.userId,
        quotaId: created.id,
        entryType: AiuLedgerEntryType.GRANT,
        consumedAfterMicros: 0,
        reservedAfterMicros: 0,
        limitAfterMicros: policy.limitAiuMicros,
        idempotencyKey: `quota-policy:${policy.id}:${input.userId}:${randomUUID()}`,
        reason: input.reason,
      },
    });
    return created;
  }
  const periodChanged =
    current.periodType !== policy.periodType ||
    (policy.periodType !== QuotaPeriodType.LIFETIME &&
      (current.periodStart.getTime() !== window.start.getTime() ||
        (current.periodEnd?.getTime() ?? null) !== (window.end?.getTime() ?? null)));
  const unchanged =
    current.policyId === policy.id &&
    current.limitAiuMicros === policy.limitAiuMicros &&
    current.hardLimit === policy.hardLimit &&
    current.enabled &&
    !periodChanged;
  if (unchanged) return current;
  if (periodChanged && current.reservedAiuMicros > 0n) {
    await database.userAiuReservation.updateMany({
      where: {
        applicationId: input.applicationId,
        userId: input.userId,
        status: AiuReservationStatus.RESERVED,
      },
      data: {
        status: AiuReservationStatus.RELEASED,
        releasedAt: new Date(),
        lockVersion: { increment: 1 },
      },
    });
  }
  const consumedAfter = periodChanged ? 0n : current.consumedAiuMicros;
  const reservedAfter = periodChanged ? 0n : current.reservedAiuMicros;
  const updated = await database.userAiuQuota.update({
    where: { id: current.id },
    data: {
      policyId: policy.id,
      periodType: policy.periodType,
      ...(periodChanged ? { periodStart: window.start, periodEnd: window.end } : {}),
      limitAiuMicros: policy.limitAiuMicros,
      consumedAiuMicros: consumedAfter,
      reservedAiuMicros: reservedAfter,
      hardLimit: policy.hardLimit,
      enabled: true,
      lockVersion: { increment: 1 },
    },
  });
  await database.userAiuLedgerEntry.create({
    data: {
      applicationId: input.applicationId,
      userId: input.userId,
      quotaId: current.id,
      entryType: AiuLedgerEntryType.GRANT,
      consumedDeltaMicros: consumedAfter - current.consumedAiuMicros,
      reservedDeltaMicros: reservedAfter - current.reservedAiuMicros,
      consumedAfterMicros: consumedAfter,
      reservedAfterMicros: reservedAfter,
      limitAfterMicros: policy.limitAiuMicros,
      idempotencyKey: `quota-policy:${policy.id}:${input.userId}:${randomUUID()}`,
      reason: input.reason,
    },
  });
  return updated;
}

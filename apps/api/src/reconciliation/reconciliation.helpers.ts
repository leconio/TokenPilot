import { BadRequestException } from "@nestjs/common";
import type { z } from "zod";

import type { Prisma } from "@tokenpilot/db";
import type { ReplayType } from "@tokenpilot/reconciliation-engine";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export function reconciliationJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function parseReconciliationRequest<T extends z.ZodType>(
  schema: T,
  input: unknown,
): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException("Invalid reconciliation request");
  return result.data;
}

export function defaultRange(
  type: "hourly" | "daily" | "manual",
  from: string | undefined,
  to: string | undefined,
  now = new Date(),
): { readonly from: string; readonly to: string } {
  if (type === "manual") {
    if (from === undefined || to === undefined) {
      throw new BadRequestException("Manual reconciliation requires from and to");
    }
    return { from, to };
  }
  const width = type === "hourly" ? HOUR_MS : DAY_MS;
  const end = to === undefined ? new Date(Math.floor(now.getTime() / width) * width) : new Date(to);
  const start = from === undefined ? new Date(end.getTime() - width) : new Date(from);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function replayTypeForDiff(diffType: string): ReplayType {
  if (diffType === "USAGE_NORMALIZATION_MISMATCH" || diffType === "DUPLICATE_PROJECTION") {
    throw new TypeError("This projection difference requires a fresh ClickHouse rebuild");
  }
  if (diffType === "PRICE_VERSION_MISMATCH") return "rerun_provider_cost";
  if (diffType === "AIU_RATE_VERSION_MISMATCH") return "rerun_aiu_observe";
  return "reproject_to_clickhouse";
}

export function page<T>(
  items: readonly T[],
  pageNumber: number,
  pageSize: number,
  total: number,
  key: string,
) {
  return {
    [key]: items,
    pagination: { page: pageNumber, page_size: pageSize, total },
  };
}

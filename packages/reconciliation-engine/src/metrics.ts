import { Decimal } from "decimal.js";

import type { ReconciliationMetrics } from "./types.js";

export const integerMetricKeys = [
  "eventCount",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "aiuMicros",
  "unpricedCount",
  "unratedCount",
] as const satisfies readonly (keyof ReconciliationMetrics)[];

export const usageMetricKeys = [
  "eventCount",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "unpricedCount",
  "unratedCount",
] as const satisfies readonly (keyof ReconciliationMetrics)[];

export function parseMetricInteger(value: string, field: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`${field} must be a non-negative integer string`);
  }
  return BigInt(value);
}

export function parseCost(value: string, field: string): Decimal {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) {
    throw new TypeError(`${field} must be a non-negative decimal string`);
  }
  const parsed = new Decimal(value);
  if (!parsed.isFinite()) throw new TypeError(`${field} must be finite`);
  return parsed;
}

export function validateMetrics(metrics: ReconciliationMetrics): void {
  for (const key of integerMetricKeys) parseMetricInteger(metrics[key], key);
  parseCost(metrics.providerCost, "providerCost");
}

export function signedIntegerDelta(left: string, right: string): string {
  return (parseMetricInteger(left, "left") - parseMetricInteger(right, "right")).toString();
}

export function signedCostDelta(left: string, right: string): string {
  return parseCost(left, "left").minus(parseCost(right, "right")).toFixed(18);
}

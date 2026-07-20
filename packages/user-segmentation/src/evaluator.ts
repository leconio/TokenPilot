import { Prisma } from "@tokenpilot/db";

import type { UserGroupCondition, UserGroupDefinition } from "./schema.js";

export interface UserGroupCandidate {
  readonly id: string;
  readonly externalId: string;
  readonly name: string | null;
  readonly tags: readonly string[];
  readonly propertiesJson: unknown;
  readonly status: string;
  readonly lastSeenAt: Date;
  readonly quota: {
    readonly limitAiuMicros: bigint;
    readonly consumedAiuMicros: bigint;
    readonly reservedAiuMicros: bigint;
  } | null;
  readonly metrics: {
    readonly calls: number;
    readonly tokens: Prisma.Decimal;
    readonly aiuMicros: bigint;
    readonly cost: Prisma.Decimal;
  };
}

function property(candidate: UserGroupCandidate, key: string | undefined): unknown {
  if (
    key === undefined ||
    candidate.propertiesJson === null ||
    typeof candidate.propertiesJson !== "object" ||
    Array.isArray(candidate.propertiesJson)
  ) {
    return undefined;
  }
  return (candidate.propertiesJson as Record<string, unknown>)[key];
}

function fieldValue(candidate: UserGroupCandidate, condition: UserGroupCondition): unknown {
  if (condition.field === "user_id") return candidate.externalId;
  if (condition.field === "display_user") return candidate.name ?? undefined;
  if (condition.field === "tag") return candidate.tags;
  if (condition.field === "status") return candidate.status.toLowerCase();
  if (condition.field === "property") return property(candidate, condition.property);
  if (condition.field === "last_seen_at") return candidate.lastSeenAt.toISOString();
  if (condition.field === "calls") return candidate.metrics.calls;
  if (condition.field === "tokens") return candidate.metrics.tokens;
  if (condition.field === "aiu") return candidate.metrics.aiuMicros;
  if (condition.field === "cost") return candidate.metrics.cost;
  const quota = candidate.quota;
  return quota === null
    ? 0n
    : quota.limitAiuMicros - quota.consumedAiuMicros - quota.reservedAiuMicros;
}

function decimal(value: unknown): Prisma.Decimal | null {
  if (value instanceof Prisma.Decimal) return value;
  if (typeof value === "bigint") return new Prisma.Decimal(value.toString());
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    return new Prisma.Decimal(value);
  } catch {
    return null;
  }
}

function equal(actual: unknown, expected: unknown): boolean {
  const left = decimal(actual);
  const right = decimal(expected);
  if (left !== null && right !== null) return left.equals(right);
  return actual === expected;
}

function ordered(actual: unknown, expected: unknown, operator: string): boolean {
  const left = decimal(actual);
  const right = decimal(expected);
  if (left !== null && right !== null) {
    if (operator === "greater_than") return left.greaterThan(right);
    if (operator === "at_least") return left.greaterThanOrEqualTo(right);
    if (operator === "less_than") return left.lessThan(right);
    return left.lessThanOrEqualTo(right);
  }
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  if (operator === "greater_than") return actual > expected;
  if (operator === "at_least") return actual >= expected;
  if (operator === "less_than") return actual < expected;
  return actual <= expected;
}

function matches(candidate: UserGroupCandidate, condition: UserGroupCondition): boolean {
  const actual = fieldValue(candidate, condition);
  if (condition.operator === "is_set") return actual !== undefined && actual !== null;
  if (condition.operator === "is_not_set") return actual === undefined || actual === null;
  const expected = condition.value;
  if (condition.operator === "equals") {
    return Array.isArray(actual)
      ? actual.some((value) => equal(value, expected))
      : equal(actual, expected);
  }
  if (condition.operator === "not_equals") {
    return Array.isArray(actual)
      ? actual.every((value) => !equal(value, expected))
      : !equal(actual, expected);
  }
  if (condition.operator === "one_of") {
    const values = Array.isArray(expected) ? expected : [expected];
    return Array.isArray(actual)
      ? actual.some((value) => values.some((candidateValue) => equal(value, candidateValue)))
      : values.some((value) => equal(actual, value));
  }
  if (condition.operator === "contains") {
    if (Array.isArray(actual)) return actual.some((value) => equal(value, expected));
    return typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
  }
  if (condition.operator === "starts_with") {
    return (
      typeof actual === "string" && typeof expected === "string" && actual.startsWith(expected)
    );
  }
  if (condition.operator === "between") {
    if (expected === null || typeof expected !== "object" || Array.isArray(expected)) return false;
    const range = expected as { readonly min?: unknown; readonly max?: unknown };
    return (
      (range.min === undefined || ordered(actual, range.min, "at_least")) &&
      (range.max === undefined || ordered(actual, range.max, "at_most"))
    );
  }
  return ordered(actual, expected, condition.operator);
}

export function evaluateUserGroup(
  definition: UserGroupDefinition,
  candidates: readonly UserGroupCandidate[],
): readonly UserGroupCandidate[] {
  return candidates.filter((candidate) => {
    const outcomes = definition.conditions.map((condition) => matches(candidate, condition));
    return definition.match === "all" ? outcomes.every(Boolean) : outcomes.some(Boolean);
  });
}

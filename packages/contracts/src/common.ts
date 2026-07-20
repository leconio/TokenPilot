import { z } from "zod";

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const UTC_RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
export const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
export const ROUTE_TAG_PATTERN = /^cp:[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+$/;
export const VIRTUAL_MODEL_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const UTC_RFC3339_PARTS_PATTERN =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?Z$/;

type UtcDateTimeSortKey = readonly [number, number, number, number, number, number, number];

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function utcDateTimeSortKey(value: string): UtcDateTimeSortKey | null {
  const match = UTC_RFC3339_PARTS_PATTERN.exec(value);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const nanosecond = Number((match[7] ?? "").padEnd(9, "0"));
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  return [year, month, day, hour, minute, second, nanosecond];
}

export function isRealUtcDateTime(value: string): boolean {
  return utcDateTimeSortKey(value) !== null;
}

export function compareUtcDateTimes(left: string, right: string): number {
  const leftKey = utcDateTimeSortKey(left);
  const rightKey = utcDateTimeSortKey(right);
  if (leftKey === null || rightKey === null) {
    throw new RangeError("Expected real RFC3339 UTC timestamps");
  }
  for (let index = 0; index < leftKey.length; index += 1) {
    const difference = leftKey[index]! - rightKey[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export const contractIdSchema = z.union([
  z.string().regex(ULID_PATTERN, "Expected a ULID"),
  z.string().regex(UUID_V7_PATTERN, "Expected a UUIDv7"),
]);

export const utcDateTimeSchema = z
  .string()
  .regex(UTC_RFC3339_PATTERN, "Expected an RFC3339 UTC timestamp ending in Z")
  .refine((value) => !Number.isNaN(Date.parse(value)), "Expected a real calendar timestamp");

export const decimalStringSchema = z
  .string()
  .regex(DECIMAL_PATTERN, "Expected a non-negative decimal string");

export const routeTagSchema = z
  .string()
  .max(200)
  .regex(ROUTE_TAG_PATTERN, "Expected a reserved cp: route tag");

export const virtualModelNameSchema = z
  .string()
  .max(120)
  .regex(VIRTUAL_MODEL_PATTERN, "Expected a normalized virtual model name");

export const nullableMetadataStringSchema = z.string().min(1).max(256).nullable();

export const semanticVersionSchema = z
  .string()
  .regex(SEMVER_PATTERN, "Expected a semantic version");

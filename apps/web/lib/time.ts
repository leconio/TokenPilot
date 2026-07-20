type AppLocale = "en" | "zh-CN";

interface LocalDateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export type InstanceLocalDateTimeDisambiguation = "earlier" | "later" | "reject";

export class InstanceLocalDateTimeError extends RangeError {
  constructor(
    readonly code: "invalid" | "nonexistent" | "ambiguous",
    message: string,
  ) {
    super(message);
    this.name = "InstanceLocalDateTimeError";
  }
}

const localDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function localParts(value: Date, timezone: string): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const number = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (part === undefined) throw new RangeError(`Intl omitted ${type} for ${timezone}`);
    return Number.parseInt(part, 10);
  };
  return {
    year: number("year"),
    month: number("month"),
    day: number("day"),
    hour: number("hour"),
    minute: number("minute"),
    second: number("second"),
  };
}

function utcValue(parts: LocalDateTimeParts): number {
  const value = new Date(0);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  value.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return value.getTime();
}

function parseLocalDateTime(value: string): LocalDateTimeParts {
  const match = localDateTimePattern.exec(value.trim());
  if (match === null) {
    throw new InstanceLocalDateTimeError("invalid", `Invalid local date-time: ${value}`);
  }
  const parts: LocalDateTimeParts = {
    year: Number.parseInt(match[1] ?? "", 10),
    month: Number.parseInt(match[2] ?? "", 10),
    day: Number.parseInt(match[3] ?? "", 10),
    hour: Number.parseInt(match[4] ?? "", 10),
    minute: Number.parseInt(match[5] ?? "", 10),
    second: Number.parseInt(match[6] ?? "0", 10),
  };
  const normalized = new Date(utcValue(parts));
  if (
    normalized.getUTCFullYear() !== parts.year ||
    normalized.getUTCMonth() + 1 !== parts.month ||
    normalized.getUTCDate() !== parts.day ||
    normalized.getUTCHours() !== parts.hour ||
    normalized.getUTCMinutes() !== parts.minute ||
    normalized.getUTCSeconds() !== parts.second
  ) {
    throw new InstanceLocalDateTimeError("invalid", `Invalid local date-time: ${value}`);
  }
  return parts;
}

function sameLocalDateTime(left: LocalDateTimeParts, right: LocalDateTimeParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

/**
 * Converts an instance-local `datetime-local` value to UTC without consulting the browser timezone.
 * A DST gap is rejected. A repeated DST hour selects its earlier occurrence unless the caller asks
 * for the later occurrence or rejects ambiguity explicitly.
 */
export function instanceLocalDateTimeToUtc(
  value: string,
  timezone: string,
  disambiguation: InstanceLocalDateTimeDisambiguation = "earlier",
): string {
  if (!(["earlier", "later", "reject"] as const).includes(disambiguation)) {
    throw new RangeError(`Invalid local date-time disambiguation: ${disambiguation}`);
  }
  const target = parseLocalDateTime(value);
  const targetValue = utcValue(target);
  const offsets = new Set<number>();

  // Sampling both sides of the requested wall time discovers every offset involved in a nearby
  // timezone transition, including non-hour and historical transitions.
  for (let deltaHours = -48; deltaHours <= 48; deltaHours += 4) {
    const sample = targetValue + deltaHours * 3_600_000;
    offsets.add(utcValue(localParts(new Date(sample), timezone)) - sample);
  }

  const candidates = Array.from(offsets, (offset) => targetValue - offset)
    .filter((candidate) => sameLocalDateTime(localParts(new Date(candidate), timezone), target))
    .filter((candidate, index, values) => values.indexOf(candidate) === index)
    .sort((left, right) => left - right);

  if (candidates.length === 0) {
    throw new InstanceLocalDateTimeError(
      "nonexistent",
      `${value} does not exist in ${timezone} because of a timezone offset transition`,
    );
  }
  if (candidates.length > 1 && disambiguation === "reject") {
    throw new InstanceLocalDateTimeError(
      "ambiguous",
      `${value} occurs more than once in ${timezone} because of a timezone offset transition`,
    );
  }
  const candidate = disambiguation === "later" ? candidates.at(-1) : candidates[0];
  if (candidate === undefined) {
    throw new InstanceLocalDateTimeError("invalid", `Unable to resolve ${value} in ${timezone}`);
  }
  return new Date(candidate).toISOString();
}

/** Formats a UTC instant for an instance-local, minute-precision `datetime-local` input. */
export function utcToInstanceDateTimeLocal(value: string | Date, timezone: string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new InstanceLocalDateTimeError("invalid", `Invalid UTC instant: ${String(value)}`);
  }
  const parts = localParts(date, timezone);
  return `${String(parts.year).padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function instantAtInstanceHour(
  timezone: string,
  hour: number,
  reference = new Date(),
): string {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError("hour must be an integer from 0 through 23");
  }
  const date = localParts(reference, timezone);
  return instanceLocalDateTimeToUtc(
    `${String(date.year).padStart(4, "0")}-${pad(date.month)}-${pad(date.day)}T${pad(hour)}:00`,
    timezone,
  );
}

export function fullDateTime(
  value: string | Date,
  timezone: string,
  locale: AppLocale = "zh-CN",
): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : "-";
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function localDate(
  value: string | Date,
  timezone: string,
  locale: AppLocale = "zh-CN",
): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : "-";
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

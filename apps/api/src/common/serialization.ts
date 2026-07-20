interface Stringable {
  toString(): string;
}

export function decimalString(value: Stringable | string): string {
  return typeof value === "string" ? value : value.toString();
}

export function integerString(value: bigint | number | string): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("Expected a safe integer");
    return value.toString();
  }
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(value)) throw new TypeError("Expected an integer string");
  return value;
}

export function displayAiu(micros: bigint | string, scale: bigint = 1_000_000n): string {
  const value = typeof micros === "bigint" ? micros : BigInt(integerString(micros));
  if (scale <= 0n) throw new TypeError("AIU scale must be positive");
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / scale;
  const remainder = absolute % scale;
  if (remainder === 0n) return `${negative ? "-" : ""}${whole.toString()}`;
  const width = scale.toString().length - 1;
  const fractional = remainder.toString().padStart(width, "0").replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole.toString()}.${fractional}`;
}

export function iso(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) throw new TypeError("Expected a valid date");
  return date.toISOString();
}

export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value === null || typeof value !== "object") return value;
  if (
    "toFixed" in value &&
    typeof (value as { readonly toFixed?: unknown }).toFixed === "function"
  ) {
    return value.toString();
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSafe(child)]));
}

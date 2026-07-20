import { createHash } from "node:crypto";

/**
 * Recursively orders object keys while retaining array order. Inputs have
 * already passed the machine contract, so only JSON values reach this helper.
 */
export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalizeJson(entry));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalizeJson(child)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

export function canonicalPayloadHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

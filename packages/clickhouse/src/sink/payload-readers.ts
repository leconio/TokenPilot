import type { ClickHouseOutboxRecord } from "./types.js";

export type JsonObject = Record<string, unknown>;

const SECRET_KEYS = new Set([
  "access_token",
  "api_key",
  "authorization",
  "bearer_token",
  "client_secret",
  "password",
  "private_key",
  "secret",
  "signature",
]);

export function object(value: unknown, name: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as JsonObject;
}

export function array(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

export function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

export function optionalString(value: unknown, name: string): string | null {
  return value === null || value === undefined ? null : string(value, name);
}

export function boolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function numeric(value: unknown, name: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

export function dateTime(value: unknown, name: string): string {
  const text = string(value, name);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${name} must be an ISO date-time`);
  return parsed.toISOString().replace("T", " ").replace("Z", "");
}

export function eventDate(value: unknown, name: string): Date {
  const parsed = new Date(string(value, name));
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${name} must be an ISO date-time`);
  return parsed;
}

export function sha256Fingerprint(value: unknown, name: string): string {
  const text = string(value, name);
  if (!/^sha256:[0-9a-f]{64}$/u.test(text)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 fingerprint`);
  }
  return text;
}

export function dimensionMap(value: unknown): Record<string, string> {
  if (value === null || value === undefined) return {};
  const input = object(value, "dimension map");
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => !SECRET_KEYS.has(key.toLowerCase()))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => {
        if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
          throw new TypeError(`dimension ${key} must be scalar`);
        }
        return [key, String(item)];
      }),
  );
}

/** Removes signing material and common credential keys before raw payloads leave PostgreSQL. */
export function redactClickHouseRawPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactClickHouseRawPayload);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .filter(([key]) => !SECRET_KEYS.has(key.toLowerCase()))
      .map(([key, item]) => [key, redactClickHouseRawPayload(item)]),
  );
}

export function delivery(record: ClickHouseOutboxRecord, suffix: string): string {
  const sourceId = record.replayOfOutboxId ?? record.id;
  if (sourceId < 1n || (record.replayOfOutboxId !== null && sourceId >= record.id)) {
    throw new TypeError("Outbox replay source identity is invalid");
  }
  return `outbox:${sourceId.toString()}:${suffix}`;
}

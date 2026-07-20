import { isSensitiveKey, redactSensitiveString } from "./security.js";

const forbiddenKeys = new Set([
  "prompt",
  "response",
  "messages",
  "apikey",
  "authorization",
  "cookie",
  "setcookie",
  "headers",
  "requestbody",
  "responsebody",
  "secret",
  "credential",
  "accesstoken",
  "refreshtoken",
  "idtoken",
]);

const untrustedIdentityKeys = new Set(["app", "appslug", "instanceid", "environment"]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

export function sanitizeUntrustedUsageEvent(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUntrustedUsageEvent(item, depth + 1));
  }
  if (typeof value === "string") return redactSensitiveString(value);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      const normalized = normalizedKey(key);
      if (
        forbiddenKeys.has(normalized) ||
        isSensitiveKey(key) ||
        (depth === 0 && untrustedIdentityKeys.has(normalized))
      ) {
        return [];
      }
      return [[key, sanitizeUntrustedUsageEvent(child, depth + 1)]];
    }),
  );
}

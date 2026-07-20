const REDACTED = "[REDACTED]";

const sensitiveKeys = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "password",
  "passwd",
  "passphrase",
  "secret",
  "secretkey",
  "privatekey",
  "providerkey",
  "apikey",
  "apiaccesskey",
  "accesskey",
  "credential",
  "credentials",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "token",
  "prompt",
  "response",
  "messages",
  "requestbody",
  "responsebody",
]);

const credentialValuePatterns = [
  /\bBearer\s+[^\s,;"']+/giu,
  /\b(?:sk|rk|pk)-[A-Za-z0-9._-]{8,}/gu,
  /\bacp_[A-Za-z0-9_-]{16,}/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
] as const;

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (normalized.endsWith("ref") || normalized.endsWith("reference")) return false;
  if (sensitiveKeys.has(normalized)) return true;
  return (
    normalized.endsWith("password") ||
    normalized.endsWith("passphrase") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("providerkey") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("secretkey") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("refreshtoken") ||
    normalized.endsWith("sessiontoken")
  );
}

export function redactSensitiveString(value: string): string {
  return credentialValuePatterns.reduce(
    (redacted, pattern) => redacted.replace(pattern, REDACTED),
    value,
  );
}

export function isCredentialLikeString(value: string): boolean {
  return redactSensitiveString(value) !== value;
}

/**
 * Redact recursively without mutating the caller's value. This is the last-line
 * boundary used by audit records and structured log payloads; request schemas
 * still reject unknown/sensitive fields before they reach this function.
 */
export function redactSensitiveData(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactSensitiveString(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return "[BINARY REDACTED]";
  if (value instanceof Error) {
    return { name: value.name, message: redactSensitiveString(value.message) };
  }
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => redactSensitiveData(entry, seen));
    seen.delete(value);
    return result;
  }
  const result = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      isSensitiveKey(key) ? REDACTED : redactSensitiveData(child, seen),
    ]),
  );
  seen.delete(value);
  return result;
}

/** Preserve Fastify's req/res objects for Pino serializers while sanitizing every
 * other structured field and message before it reaches a log transport. */
export function redactLogArguments(values: readonly unknown[]): unknown[] {
  return values.map((value) => {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value instanceof Error ||
      value instanceof Date ||
      Buffer.isBuffer(value)
    ) {
      return redactSensitiveData(value);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        ["req", "request", "res", "response"].includes(key) &&
        child !== null &&
        typeof child === "object" &&
        "raw" in child
          ? child
          : redactSensitiveData(child),
      ]),
    );
  });
}

export { REDACTED };

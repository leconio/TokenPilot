import { AsyncLocalStorage } from "node:async_hooks";

import { ulid } from "ulid";

import type { AiRuntimeContext, ResolvedAiRuntimeContext } from "./types.js";

const storage = new AsyncLocalStorage<ResolvedAiRuntimeContext>();
const propertyKey = /^[a-z][a-z0-9._-]{0,127}$/u;
const unsafePropertyKeys = new Set([
  "api_key",
  "authorization",
  "cookie",
  "messages",
  "prompt",
  "response",
]);

function identifier(prefix: string): string {
  return `${prefix}_${ulid().toLowerCase()}`;
}

function bounded(value: string | undefined, field: string, maximum: number): string | null {
  if (value === undefined) return null;
  const candidate = value.trim();
  if (candidate.length === 0 || [...candidate].length > maximum) {
    throw new TypeError(`${field} must contain 1-${maximum} characters`);
  }
  return candidate;
}

function properties(
  value: AiRuntimeContext["eventProperties"],
  field: string,
): Readonly<Record<string, string | number | boolean | readonly string[]>> {
  const entries = Object.entries(value ?? {});
  if (entries.length > 64) throw new TypeError(`${field} supports at most 64 properties`);
  return Object.freeze(
    Object.fromEntries(
      entries.map(([key, child]) => {
        if (!propertyKey.test(key) || unsafePropertyKeys.has(key)) {
          throw new TypeError(`${field}.${key} is not an allowed property key`);
        }
        if (typeof child === "string") {
          if ([...child].length === 0 || [...child].length > 2_048) {
            throw new TypeError(`${field}.${key} must contain 1-2048 characters`);
          }
        } else if (typeof child === "number") {
          if (!Number.isFinite(child) || Math.abs(child) > Number.MAX_SAFE_INTEGER) {
            throw new TypeError(`${field}.${key} must be a finite, safely representable number`);
          }
        } else if (Array.isArray(child)) {
          if (
            child.length > 32 ||
            new Set(child).size !== child.length ||
            child.some((item) => [...item].length === 0 || [...item].length > 256)
          ) {
            throw new TypeError(`${field}.${key} must be a unique list of at most 32 short texts`);
          }
        } else if (typeof child !== "boolean") {
          throw new TypeError(`${field}.${key} has an unsupported value`);
        }
        return [key, Array.isArray(child) ? Object.freeze([...child]) : child] as const;
      }),
    ),
  );
}

function resolved(input: AiRuntimeContext): ResolvedAiRuntimeContext {
  const userId = bounded(input.userId, "userId", 256);
  if (userId === null) throw new TypeError("userId is required");
  return Object.freeze({
    userId,
    displayUser: bounded(input.displayUser, "displayUser", 256),
    applicationVersion: bounded(input.applicationVersion, "applicationVersion", 64),
    operationId: bounded(input.operationId, "operationId", 256) ?? identifier("op"),
    requestId: identifier("req"),
    parentRequestId: bounded(input.parentRequestId, "parentRequestId", 256),
    sessionId: bounded(input.sessionId, "sessionId", 256),
    conversationId: bounded(input.conversationId, "conversationId", 256),
    traceId: identifier("trace"),
    callSource: bounded(input.callSource, "callSource", 120),
    eventProperties: properties(input.eventProperties, "eventProperties"),
    userProperties: properties(input.userProperties, "userProperties"),
    analyticsDimensions: Object.freeze({ ...(input.analyticsDimensions ?? {}) }),
  });
}

export function withAiContext<T>(input: AiRuntimeContext, operation: () => T): T {
  return storage.run(resolved(input), operation);
}

export function currentAiContext(): ResolvedAiRuntimeContext | null {
  return storage.getStore() ?? null;
}

export function requireAiContext(): ResolvedAiRuntimeContext {
  const context = currentAiContext();
  if (context === null) throw new Error("No AI runtime context is active");
  return context;
}

import type { Request, Route } from "@playwright/test";

export function bodyOf(request: Request): unknown {
  const raw = request.postData();
  if (raw === null || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function objectBody(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function reportEnvelope(now: string, data: unknown) {
  return {
    watermark: now,
    lag_seconds: 2,
    range: { from: "2026-07-15T00:00:00.000Z", to: now, timezone: "UTC" },
    data,
  };
}

export async function json(route: Route, value: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
  });
}

export async function problem(route: Route, status: number, message: string): Promise<void> {
  await json(route, { statusCode: status, message, error: "E2E simulated failure" }, status);
}

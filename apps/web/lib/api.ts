"use client";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly diagnostic?: string,
    readonly code?: string,
    readonly payload?: unknown,
  ) {
    super(message);
  }
}

export function friendlyApiMessage(status: number, diagnostic?: string): string {
  if (diagnostic && /[\u3400-\u9fff]/u.test(diagnostic)) return diagnostic;
  if (status === 400 || status === 422) return "填写内容有误，请检查后重试。";
  if (status === 401) return "登录已失效，请重新登录。";
  if (status === 403) return "没有执行此操作的权限。";
  if (status === 404) return "没有找到所需内容。";
  if (status === 409) return "当前内容已被更新，请刷新后重试。";
  if (status === 413) return "提交内容过大。";
  if (status === 429) return "操作过于频繁，请稍后重试。";
  if (status >= 500) return "服务暂时不可用，请稍后重试。";
  return "请求未完成，请重试。";
}

function cookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  for (const part of document.cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

export async function controlApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrf = cookie("cp_csrf");
    if (csrf !== undefined) headers.set("x-csrf-token", csrf);
  }
  const response = await fetch(`/api/control${path}`, {
    ...init,
    method,
    headers,
    credentials: "include",
    cache: "no-store",
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const diagnostic =
      payload !== null && typeof payload === "object" && "message" in payload
        ? String(payload.message)
        : undefined;
    const code =
      payload !== null && typeof payload === "object" && "code" in payload
        ? String(payload.code)
        : undefined;
    throw new ApiError(
      friendlyApiMessage(response.status, diagnostic),
      response.status,
      diagnostic,
      code,
      payload,
    );
  }
  return payload as T;
}

export const apiFetch = controlApi;

export function postJson<T>(path: string, value: unknown, method = "POST"): Promise<T> {
  return controlApi<T>(path, { method, body: JSON.stringify(value) });
}

export function jsonBody(value: unknown): Pick<RequestInit, "body"> {
  return { body: JSON.stringify(value) };
}

export function reportRange(range: string): { from: string; to: string } {
  const to = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const duration =
    range === "1h"
      ? 3_600_000
      : range === "7d"
        ? 7 * 86_400_000
        : range === "30d"
          ? 30 * 86_400_000
          : 86_400_000;
  return { from: new Date(to.getTime() - duration).toISOString(), to: to.toISOString() };
}

type QueryValue = string | number | readonly string[] | null | undefined;

export function query(parameters: Readonly<Record<string, QueryValue>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item !== undefined && item !== null && String(item).length > 0) {
        search.append(key, String(item));
      }
    }
  }
  const result = search.toString();
  return result.length === 0 ? "" : `?${result}`;
}

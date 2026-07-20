"use client";

import { ApiError, controlApi, friendlyApiMessage, query } from "@/lib/api";
import type { CursorPageEnvelope, PageEnvelope } from "./types";

export interface ListQuery {
  readonly page?: number;
  readonly limit?: number;
  readonly page_size?: number;
  readonly sort?: string;
  readonly order?: "asc" | "desc";
  readonly from?: string;
  readonly to?: string;
  readonly timezone?: string;
  readonly [key: string]: string | number | readonly string[] | undefined;
}

export function controlPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

export function controlGet<T>(path: string, parameters?: ListQuery): Promise<T> {
  return controlApi<T>(`${controlPath(path)}${parameters ? query(parameters) : ""}`);
}

function downloadFileName(response: Response, fallback: string): string {
  const disposition = response.headers.get("content-disposition") ?? "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/iu)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/iu)?.[1];
  let candidate = plain ?? fallback;
  if (encoded !== undefined) {
    try {
      candidate = decodeURIComponent(encoded);
    } catch {
      candidate = fallback;
    }
  }
  return candidate.replaceAll(/[\\/\0]/gu, "_") || fallback;
}

export async function controlDownload(
  path: string,
  parameters: ListQuery,
  fallbackFileName: string,
): Promise<void> {
  const response = await fetch(`/api/control${controlPath(path)}${query(parameters)}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const diagnostic = typeof payload?.message === "string" ? payload.message : undefined;
    const code = typeof payload?.code === "string" ? payload.code : undefined;
    throw new ApiError(
      friendlyApiMessage(response.status, diagnostic),
      response.status,
      diagnostic,
      code,
    );
  }
  const url = URL.createObjectURL(await response.blob());
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = downloadFileName(response, fallbackFileName);
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function controlGetAllPages<T>(
  path: string,
  parameters: Omit<ListQuery, "page" | "limit"> = {},
  preferredKeys: readonly string[] = [],
): Promise<PageEnvelope<T>> {
  const items: T[] = [];
  let page = 1;
  for (;;) {
    const payload = await controlGet<unknown>(path, { ...parameters, page, limit: 100 });
    const current = normalizePage<T>(payload, preferredKeys);
    items.push(...current.items);
    if (current.items.length === 0 || items.length >= current.total) {
      return { items, page: 1, page_size: items.length, total: current.total };
    }
    page += 1;
  }
}

export function controlMutate<TResponse, TBody = unknown>(
  path: string,
  body: TBody,
  method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST",
): Promise<TResponse> {
  return controlApi<TResponse>(controlPath(path), { method, body: JSON.stringify(body) });
}

export function normalizePage<T>(
  payload: unknown,
  preferredKeys: readonly string[] = [],
): PageEnvelope<T> {
  if (Array.isArray(payload))
    return {
      items: payload as readonly T[],
      page: 1,
      page_size: payload.length,
      total: payload.length,
    };
  if (!payload || typeof payload !== "object")
    return { items: [], page: 1, page_size: 25, total: 0 };
  const record = payload as Record<string, unknown>;
  const keys = [...preferredKeys, "items", "data", "rows", "results"];
  const items = keys.map((key) => record[key]).find(Array.isArray) as readonly T[] | undefined;
  const meta =
    record.pagination && typeof record.pagination === "object"
      ? (record.pagination as Record<string, unknown>)
      : record;
  return {
    items: items ?? [],
    page: Number(meta.page ?? meta.current_page ?? 1),
    page_size: Number(meta.page_size ?? meta.limit ?? Math.max(items?.length ?? 0, 25)),
    total: Number(meta.total ?? meta.total_count ?? items?.length ?? 0),
    next_cursor: typeof meta.next_cursor === "string" ? meta.next_cursor : null,
  };
}

export function normalizeCursorPage<T>(payload: unknown): CursorPageEnvelope<T> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { items: [], page_size: 25, total: 0, next_cursor: null };
  }
  const record = payload as Record<string, unknown>;
  return {
    items: Array.isArray(record.items) ? (record.items as readonly T[]) : [],
    page_size: Number(record.page_size ?? 25),
    total: Number(record.total ?? 0),
    next_cursor: typeof record.next_cursor === "string" ? record.next_cursor : null,
  };
}

export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ") || "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

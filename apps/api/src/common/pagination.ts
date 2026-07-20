import { BadRequestException } from "@nestjs/common";

export interface PageRequest {
  readonly limit: number;
  readonly cursor: string | null;
  readonly direction: "asc" | "desc";
}

function first(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

export function pageRequest(
  query: Readonly<Record<string, unknown>>,
  options: { readonly defaultLimit?: number; readonly maxLimit?: number } = {},
): PageRequest {
  const limitValue = first(query.limit);
  const limit = limitValue === undefined ? (options.defaultLimit ?? 50) : Number(limitValue);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > (options.maxLimit ?? 200)) {
    throw new BadRequestException(`limit must be between 1 and ${options.maxLimit ?? 200}`);
  }
  const cursor = first(query.cursor) ?? null;
  if (cursor !== null && (cursor.length === 0 || cursor.length > 512)) {
    throw new BadRequestException("cursor is invalid");
  }
  const directionValue = first(query.direction) ?? "desc";
  if (directionValue !== "asc" && directionValue !== "desc") {
    throw new BadRequestException("direction must be asc or desc");
  }
  return { limit, cursor, direction: directionValue };
}

export function pageEnvelope<T>(
  items: readonly T[],
  requestedLimit: number,
): {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
} {
  const visible = items.slice(0, requestedLimit);
  const next = items.length > requestedLimit ? visible.at(-1) : undefined;
  const id =
    next !== undefined && typeof next === "object" && next !== null && "id" in next
      ? (next as { readonly id?: unknown }).id
      : undefined;
  return {
    items: visible,
    next_cursor: typeof id === "string" ? id : null,
  };
}

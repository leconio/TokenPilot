"use client";

import { usePathname } from "next/navigation";

export function useCurrentApplicationSlug(): string {
  return /^\/apps\/([^/]+)/u.exec(usePathname())?.[1] ?? "";
}

export function applicationApiPath(applicationSlug: string, path: string): string | null {
  if (applicationSlug.length === 0) return null;
  return `/applications/${encodeURIComponent(applicationSlug)}${path}`;
}

"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { LanguageSwitcher } from "./language-switcher";
import { LocaleProvider } from "../i18n/locale-provider";
import type { AppLocale } from "../i18n/translator";

export function Providers({
  children,
  initialLocale,
}: Readonly<{ children: React.ReactNode; initialLocale: AppLocale }>) {
  const pathname = usePathname();
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );
  return (
    <LocaleProvider initialLocale={initialLocale}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
      {pathname.startsWith("/apps/") ? null : <LanguageSwitcher />}
    </LocaleProvider>
  );
}

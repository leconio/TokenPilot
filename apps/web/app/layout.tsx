import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";

import { Providers } from "../components/providers";
import type { AppLocale } from "../i18n/translator";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.WEB_PUBLIC_URL ?? "http://127.0.0.1:3000"),
  title: { default: "TokenPilot", template: "%s · TokenPilot" },
  description:
    "Token usage analytics, model routing, provider cost, and AI Unit design for AI applications.",
  openGraph: {
    type: "website",
    title: "TokenPilot",
    description:
      "Token usage analytics, model routing, provider cost, and AI Unit design for AI applications.",
  },
  twitter: {
    card: "summary_large_image",
    title: "TokenPilot",
    description:
      "Token usage analytics, model routing, provider cost, and AI Unit design for AI applications.",
  },
};

async function requestLocale(): Promise<AppLocale> {
  const cookieLocale = (await cookies()).get("tokenpilot_locale")?.value;
  if (cookieLocale === "en" || cookieLocale === "zh-CN") return cookieLocale;
  const acceptedLanguages = (await headers()).get("accept-language")?.toLowerCase() ?? "";
  return acceptedLanguages.startsWith("zh") ? "zh-CN" : "en";
}

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const locale = await requestLocale();
  return (
    <html lang={locale} suppressHydrationWarning>
      <body>
        <Providers initialLocale={locale}>{children}</Providers>
      </body>
    </html>
  );
}

export function decimal(value: string | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return "-";
  const negative = value.startsWith("-");
  const normalized = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = normalized.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const visible = digits === 0 ? "" : `.${fraction.padEnd(digits, "0").slice(0, digits)}`;
  return `${negative ? "−" : ""}${grouped}${visible}`;
}

export function dateTime(
  value: string | null | undefined,
  timezone: string,
  locale: AppLocale = "zh-CN",
): string {
  if (value === null || value === undefined) return "-";
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function compactId(value: string | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-5)}`;
}

export function label(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) return "未标记";
  return value.replaceAll("_", " ");
}
import type { AppLocale } from "@/i18n/translator";

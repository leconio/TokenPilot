import type { AnalysisGrain, AnalysisGroup } from "../usage/analysis-config";
import type { AppLocale } from "@/i18n/translator";

export { formatAiuMicros } from "../quota/aiu-values";

export interface AiuGroupRow {
  readonly dimension: string;
  readonly key: string;
  readonly aiu_micros: string;
}

export function aiuTimeLabel(
  value: string,
  grain: AnalysisGrain,
  locale: AppLocale = "zh-CN",
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    return value || (locale === "en" ? "Not provided" : "未填写");
  if (grain === "month") {
    return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(date);
  }
  const datePart = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  if (grain === "week") return locale === "en" ? `Week of ${datePart}` : `${datePart} 当周`;
  if (grain === "day") return datePart;
  const timePart = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${datePart} ${timePart}`;
}

export function aiuGroupLabel(
  row: AiuGroupRow,
  group: AnalysisGroup,
  grain: AnalysisGrain,
  userLabels: ReadonlyMap<string, string>,
  locale: AppLocale = "zh-CN",
): string {
  if (group.kind === "builtin" && group.dimension === "time")
    return aiuTimeLabel(row.key, grain, locale);
  if (group.kind === "builtin" && group.dimension === "user_id")
    return userLabels.get(row.key) ?? (locale === "en" ? "Unknown user" : "未知用户");
  return row.key || (locale === "en" ? "Not provided" : "未填写");
}

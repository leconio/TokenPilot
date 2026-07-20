"use client";

import Link from "next/link";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  applicationApiPath,
  useCurrentApplicationSlug,
} from "@/features/applications/use-current-application";
import type { ReportEnvelope } from "../control-plane/api/types";
import { useControlQuery } from "../control-plane/api/hooks";
import {
  analysisGroupLabel,
  analysisRanges,
  reportParameters,
  selectionFromDefinition,
  type AnalysisKind,
  type SavedReportDefinition,
} from "../control-plane/usage/analysis-config";
import { useAnalysisCatalog } from "../control-plane/usage/analysis-options";
import { formatAiuMicros } from "../control-plane/quota/aiu-values";
import { useLocale } from "@/i18n/locale-provider";
import { translateText, type AppLocale } from "@/i18n/translator";

interface SavedReport {
  readonly id: string;
  readonly name: string;
  readonly kind: AnalysisKind;
  readonly definition: SavedReportDefinition;
}

interface DashboardCard {
  readonly id: string;
  readonly width: number;
  readonly report: SavedReport;
}

function reportPage(applicationSlug: string, report: SavedReport): string {
  const page = report.kind === "aiu" ? "ai-units" : report.kind === "cost" ? "costs" : "usage";
  return `/apps/${applicationSlug}/${page}?saved_report=${encodeURIComponent(report.id)}`;
}

function reportValue(
  kind: AnalysisKind,
  data: unknown,
  metric: SavedReportDefinition["metric"],
  locale: AppLocale,
): string {
  if (data === null || typeof data !== "object") return "-";
  const value = data as Record<string, unknown>;
  if (kind === "aiu") {
    const total = value.total as { micros?: unknown; display?: unknown } | undefined;
    if (typeof total?.display === "string") return total.display;
    return formatAiuMicros(typeof total?.micros === "string" ? total.micros : undefined, locale);
  }
  if (kind === "cost") {
    const total = value.total as { value?: unknown; currency?: unknown } | undefined;
    return typeof total?.value === "string"
      ? `${typeof total.currency === "string" ? total.currency : ""} ${total.value}`.trim()
      : "-";
  }
  const total = value.total;
  if (typeof total !== "string") return "-";
  const suffix =
    metric === "requests"
      ? "次"
      : metric === "tokens"
        ? "Token"
        : metric === "unique_users"
          ? "人"
          : metric === "success_rate"
            ? "%"
            : "ms";
  return `${total} ${suffix}`;
}

function SavedDashboardCard({ card }: Readonly<{ card: DashboardCard }>) {
  const { locale } = useLocale();
  const applicationSlug = useCurrentApplicationSlug();
  const catalog = useAnalysisCatalog(card.report.kind);
  const selection = useMemo(
    () => selectionFromDefinition(card.report.definition, catalog.propertyFields),
    [card.report.definition, catalog.propertyFields],
  );
  const endpoint =
    card.report.kind === "aiu"
      ? "/reports/aiu"
      : card.report.kind === "cost"
        ? "/reports/provider-cost"
        : "/reports/activity";
  const parameters = useMemo(
    () => reportParameters(selection, new Date(), true, true, 100),
    [card.report.kind, selection],
  );
  const result = useControlQuery<ReportEnvelope<unknown>>(
    ["dashboard-report-result", applicationSlug, card.report.id],
    applicationApiPath(applicationSlug, endpoint),
    parameters,
    { retry: false },
  );
  const rangeLabel =
    analysisRanges.find((range) => range.value === card.report.definition.range)?.label ??
    card.report.definition.range;
  const groupLabel = analysisGroupLabel(selection.group);
  return (
    <Card className={card.width === 2 ? "lg:col-span-2" : ""}>
      <CardHeader>
        <CardTitle data-i18n-skip>{card.report.name}</CardTitle>
        <CardDescription>
          {translateText(rangeLabel, locale)} · {locale === "en" ? "By " : "按"}
          <span data-i18n-skip={selection.group.kind === "property" ? true : undefined}>
            {selection.group.kind === "property" ? groupLabel : translateText(groupLabel, locale)}
          </span>
          {locale === "en" ? "" : "查看"}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="text-3xl font-semibold tabular-nums">
          {result.isPending
            ? "读取中…"
            : result.isError
              ? "暂时不可用"
              : reportValue(
                  card.report.kind,
                  result.data?.data,
                  card.report.definition.metric,
                  locale,
                )}
        </div>
        <Button asChild size="sm" variant="outline" className="w-fit">
          <Link href={reportPage(applicationSlug, card.report)}>打开报表</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export function SavedDashboard() {
  const applicationSlug = useCurrentApplicationSlug();
  const cards = useControlQuery<{ cards: readonly DashboardCard[] }>(
    ["dashboard-reports", applicationSlug],
    applicationApiPath(applicationSlug, "/reports/dashboard"),
    undefined,
    { retry: false },
  );
  if (cards.isPending || cards.isError || (cards.data?.cards.length ?? 0) === 0) return null;
  return (
    <section className="grid gap-3" aria-label="已保存报表">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">我的报表</h2>
        <Button asChild size="sm" variant="ghost">
          <Link href={`/apps/${applicationSlug}/reports`}>管理报表</Link>
        </Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {cards.data!.cards.map((card) => (
          <SavedDashboardCard key={card.id} card={card} />
        ))}
      </div>
    </section>
  );
}

"use client";

import Decimal from "decimal.js";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { AlertTriangle, CircleDollarSign, Route } from "lucide-react";
import {
  applicationApiPath,
  useCurrentApplicationSlug,
} from "@/features/applications/use-current-application";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricCard } from "@/components/metric-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeading } from "@/features/shared/components/page-heading";
import { PageState } from "@/features/shared/components/page-state";
import { PermissionBoundary } from "@/features/shared/components/permission-boundary";
import { CursorPager } from "@/features/shared/components/cursor-pager";
import { useCursorPages } from "@/features/shared/hooks/use-cursor-pages";
import { useLocale } from "@/i18n/locale-provider";
import { translateText, type AppLocale } from "@/i18n/translator";
import { useControlQuery } from "../api/hooks";
import type { ReportEnvelope } from "../api/types";
import { AnalysisBuilder } from "../usage/analysis-builder";
import { useAnalysisCatalog } from "../usage/analysis-options";
import {
  analysisFileName,
  analysisGroupLabel,
  analysisRanges,
  analysisSelectionFromSearch,
  reportParameters,
  rowsToCsv,
  selectionForGroupDrill,
  selectionToDefinition,
  type AnalysisSelection,
} from "../usage/analysis-config";

interface MoneyValue {
  readonly value: string;
  readonly currency: string;
}

interface CostGroup {
  readonly dimension: string;
  readonly key: string;
  readonly currency: string;
  readonly amount: string;
}

interface CostReport {
  readonly total?: MoneyValue | null;
  readonly totals?: readonly MoneyValue[];
  readonly failed_attempt_cost?: MoneyValue | null;
  readonly fallback_extra_cost?: MoneyValue | null;
  readonly unpriced_events?: number;
  readonly groups?: readonly CostGroup[];
  readonly total_groups?: number;
  readonly next_cursor?: string | null;
}

function money(value: MoneyValue | null | undefined, locale: AppLocale): string {
  if (!value) return "-";
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: value.currency,
      maximumFractionDigits: 6,
    }).format(new Decimal(value.value).toNumber());
  } catch {
    return `${value.currency} ${value.value}`;
  }
}

function totalMoney(report: CostReport | undefined, locale: AppLocale): string {
  if (report?.total) return money(report.total, locale);
  if (report?.totals?.length) return report.totals.map((value) => money(value, locale)).join(" / ");
  return "-";
}

function CostSummary({ report }: Readonly<{ report: CostReport | undefined }>) {
  const { locale, text } = useLocale();
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        label="模型总花费"
        value={totalMoney(report, locale)}
        description="所选时间内支付给模型服务商的成本"
        icon={<CircleDollarSign className="size-5" />}
      />
      <MetricCard
        label="未配置成本"
        value={
          report?.unpriced_events === undefined
            ? "-"
            : `${report.unpriced_events} ${text("次", "calls")}`
        }
        description="不会把缺少价格的调用计算为 0"
        icon={<AlertTriangle className="size-5" />}
      />
      <MetricCard
        label="失败调用花费"
        value={money(report?.failed_attempt_cost, locale)}
        description="调用失败但服务商已产生的成本"
      />
      <MetricCard
        label="备用模型额外花费"
        value={money(report?.fallback_extra_cost, locale)}
        description="切换备用模型后产生的成本"
        icon={<Route className="size-5" />}
      />
    </div>
  );
}

function GroupChart({
  groups,
  groupLabel,
  customGroup,
  drillHref,
  timeGroup = false,
}: Readonly<{
  groups: readonly CostGroup[];
  groupLabel: string;
  customGroup: boolean;
  drillHref?: ((row: CostGroup) => string | null) | undefined;
  timeGroup?: boolean | undefined;
}>) {
  const { locale, text } = useLocale();
  const visible = groups.slice(0, 12);
  const maximum = visible.reduce(
    (current, row) => Decimal.max(current, new Decimal(row.amount).abs()),
    new Decimal(0),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {timeGroup ? (
            text("模型花费趋势", "Model cost trend")
          ) : (
            <>
              {text("按", "By ")}
              <span data-i18n-skip={customGroup ? true : undefined}>
                {customGroup
                  ? groupLabel
                  : translateText(groupLabel, locale).toLocaleLowerCase(locale)}
              </span>
              {locale === "zh-CN" ? "查看" : ""}
            </>
          )}
        </CardTitle>
        <CardDescription>
          {text("当前页展示", "Shown on this page")} {Math.min(groups.length, 12)}{" "}
          {text("项。", "items.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {visible.length === 0 ? (
          <PageState state="empty" message="所选条件下没有可展示的模型花费。" />
        ) : (
          visible.map((row) => {
            const width = maximum.isZero()
              ? 0
              : new Decimal(row.amount).abs().div(maximum).mul(100).toNumber();
            const content = (
              <>
                <div className="flex min-w-0 items-center justify-between gap-3 text-sm">
                  {row.key ? (
                    <span className="truncate" title={row.key} data-i18n-skip>
                      {row.key}
                    </span>
                  ) : (
                    <span className="truncate">未填写</span>
                  )}
                  <span className="shrink-0 font-medium tabular-nums">
                    {money({ value: row.amount, currency: row.currency }, locale)}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${Math.max(width, width > 0 ? 2 : 0)}%` }}
                  />
                </div>
              </>
            );
            const href = drillHref?.(row) ?? null;
            return href === null ? (
              <div key={`${row.dimension}-${row.key}-${row.currency}`} className="grid gap-1.5">
                {content}
              </div>
            ) : (
              <Link
                key={`${row.dimension}-${row.key}-${row.currency}`}
                className="grid gap-1.5 rounded-md outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                href={href}
              >
                {content}
              </Link>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function downloadCsv(contents: string, fileName: string) {
  const blob = new Blob(["\uFEFF", contents], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function usageHref(applicationSlug: string, selection: AnalysisSelection): string {
  const search = new URLSearchParams({
    range: selection.range,
    filter_match: selection.match,
    conditions: JSON.stringify(selectionToDefinition(selection).conditions),
  });
  return `/apps/${applicationSlug}/usage?${search.toString()}`;
}

export function CostsPage() {
  const applicationSlug = useCurrentApplicationSlug();
  const { locale, text } = useLocale();
  const search = useSearchParams();
  const [draft, setDraft] = useState<AnalysisSelection>(() =>
    analysisSelectionFromSearch("cost", search),
  );
  const [applied, setApplied] = useState<AnalysisSelection>(() =>
    analysisSelectionFromSearch("cost", search),
  );
  const cursorPages = useCursorPages(JSON.stringify(applied));
  const catalog = useAnalysisCatalog("cost");
  const parameters = useMemo(
    () => ({
      ...reportParameters(applied, new Date(), true, true),
      ...(cursorPages.cursor === null ? {} : { cursor: cursorPages.cursor }),
    }),
    [applied, cursorPages.cursor],
  );
  const report = useControlQuery<ReportEnvelope<CostReport>>(
    ["cost-analysis", applicationSlug, applied, cursorPages.cursor],
    applicationApiPath(applicationSlug, "/reports/provider-cost"),
    parameters,
    { retry: false },
  );
  const data = report.data?.data;
  const groups = data?.groups ?? [];
  const rangeLabel = analysisRanges.find((range) => range.value === applied.range)?.label;
  const exportRows = groups.map((row) => ({
    [text("分组", "Group")]:
      applied.group.kind === "property"
        ? analysisGroupLabel(applied.group)
        : translateText(analysisGroupLabel(applied.group), locale),
    [text("名称", "Name")]: row.key || text("未填写", "Not provided"),
    [text("币种", "Currency")]: row.currency,
    [text("花费", "Cost")]: row.amount,
  }));

  return (
    <main className="page">
      <PageHeading title="模型花费" description="统计模型调用产生的实际花费。" />
      <PermissionBoundary permission="reports:read">
        <Tabs defaultValue="dashboard" className="grid gap-5">
          <TabsList aria-label="模型花费页面">
            <TabsTrigger value="dashboard">仪表盘</TabsTrigger>
            <TabsTrigger value="analysis">自助分析</TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard" className="grid gap-5">
            {report.isPending ? <PageState state="loading" /> : null}
            {report.isError ? (
              <PageState
                state="error"
                message="分析服务暂时不可用，请稍后重试或联系管理员。"
                onRetry={() => void report.refetch()}
              />
            ) : null}
            {report.isSuccess ? (
              <>
                <CostSummary report={data} />
                {(data?.unpriced_events ?? 0) > 0 ? (
                  <Alert>
                    <AlertDescription>
                      有 {data?.unpriced_events} 次调用尚未配置成本，当前总花费不包含这些调用。
                    </AlertDescription>
                  </Alert>
                ) : null}
                <GroupChart
                  groups={groups}
                  groupLabel={analysisGroupLabel(applied.group)}
                  customGroup={applied.group.kind === "property"}
                  timeGroup={applied.group.kind === "builtin" && applied.group.dimension === "time"}
                  drillHref={(row) => {
                    const selection = selectionForGroupDrill(
                      applied,
                      catalog.propertyFields,
                      row.key,
                    );
                    return selection === null ? null : usageHref(applicationSlug, selection);
                  }}
                />
              </>
            ) : null}
          </TabsContent>

          <TabsContent value="analysis" className="grid gap-5">
            <AnalysisBuilder
              kind="cost"
              value={draft}
              onChange={setDraft}
              onLoad={(selection) => {
                setDraft(selection);
                setApplied(selection);
              }}
              onRun={() => {
                if (applied === draft) void report.refetch();
                else setApplied(draft);
              }}
              pending={report.isFetching}
              exportDisabled={groups.length === 0}
              onExport={() => downloadCsv(rowsToCsv(exportRows), analysisFileName("cost"))}
            />
            {report.isPending ? <PageState state="loading" /> : null}
            {report.isError ? (
              <PageState
                state="error"
                message="分析服务暂时不可用，请稍后重试或联系管理员。"
                onRetry={() => void report.refetch()}
              />
            ) : null}
            {report.isSuccess ? (
              <>
                <CostSummary report={data} />
                <GroupChart
                  groups={groups}
                  groupLabel={analysisGroupLabel(applied.group)}
                  customGroup={applied.group.kind === "property"}
                  timeGroup={applied.group.kind === "builtin" && applied.group.dimension === "time"}
                  drillHref={(row) => {
                    const selection = selectionForGroupDrill(
                      applied,
                      catalog.propertyFields,
                      row.key,
                    );
                    return selection === null ? null : usageHref(applicationSlug, selection);
                  }}
                />
                <CursorPager
                  page={cursorPages.page}
                  hasNext={typeof data?.next_cursor === "string"}
                  onPrevious={cursorPages.previous}
                  onNext={() => {
                    if (data?.next_cursor) cursorPages.next(data.next_cursor);
                  }}
                />
                <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
                  <span>
                    {translateText(rangeLabel ?? "", locale)} · {text("共", "Total")}{" "}
                    {data?.total_groups ?? groups.length} {text("个分组", "groups")}
                  </span>
                  <Button asChild variant="outline">
                    <Link href={usageHref(applicationSlug, applied)}>查看调用明细</Link>
                  </Button>
                </div>
              </>
            ) : null}
          </TabsContent>
        </Tabs>
      </PermissionBoundary>
    </main>
  );
}

"use client";

import { useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { useInstanceTimezone } from "@/components/instance-timezone";
import {
  applicationApiPath,
  useCurrentApplicationSlug,
} from "@/features/applications/use-current-application";
import { MetricCard } from "@/components/metric-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { controlDownload, normalizeCursorPage } from "@/features/control-plane/api/client";
import { useControlQuery } from "@/features/control-plane/api/hooks";
import type { ReportEnvelope } from "@/features/control-plane/api/types";
import { DataTable, type DataColumn } from "@/features/shared/components/data-table";
import { CursorPager } from "@/features/shared/components/cursor-pager";
import { PageHeading } from "@/features/shared/components/page-heading";
import { PageState } from "@/features/shared/components/page-state";
import { PermissionBoundary } from "@/features/shared/components/permission-boundary";
import { StatusBadge } from "@/features/shared/components/status-badge";
import { useCursorPages } from "@/features/shared/hooks/use-cursor-pages";
import { useLocale } from "@/i18n/locale-provider";
import { dateTime } from "@/lib/format";
import { formatAiuMicros } from "../quota/aiu-values";
import {
  analysisFileName,
  analysisGroupLabel,
  analysisMetrics,
  analysisSelectionFromSearch,
  reportParameters,
  selectionForGroupDrill,
} from "./analysis-config";
import { useAnalysisCatalog, useUserLabelMap } from "./analysis-options";
import { ActivityTrendChart } from "./activity-trend-chart";
import { AnalysisBuilder } from "./analysis-builder";
import { UsageDetailSheet } from "./usage-detail-sheet";
import { usageCost, type UsageRow } from "./usage-row";

interface ActivityPoint {
  readonly key: string;
  readonly value: string | null;
}

interface ActivityReport {
  readonly metric: "requests" | "tokens" | "unique_users" | "success_rate" | "average_latency";
  readonly unit: "calls" | "tokens" | "users" | "percent" | "milliseconds";
  readonly total: string | null;
  readonly groups: readonly ActivityPoint[];
  readonly trend: readonly ActivityPoint[];
  readonly total_groups: number;
  readonly next_cursor: string | null;
}

const metricUnits: Readonly<Record<ActivityReport["metric"], string>> = {
  requests: "次",
  tokens: "Token",
  unique_users: "人",
  success_rate: "%",
  average_latency: "ms",
};

function metricValue(
  value: string | null | undefined,
  metric: ActivityReport["metric"],
  locale: "zh-CN" | "en",
): string {
  if (value === null || value === undefined) return "-";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: metric === "success_rate" || metric === "average_latency" ? 2 : 0,
  }).format(numeric);
  return `${formatted} ${metricUnits[metric]}`;
}

export function UsagePage() {
  const { locale } = useLocale();
  const applicationSlug = useCurrentApplicationSlug();
  const timezone = useInstanceTimezone();
  const searchParams = useSearchParams();
  const [draft, setDraft] = useState(() => analysisSelectionFromSearch("usage", searchParams));
  const [applied, setApplied] = useState(() => analysisSelectionFromSearch("usage", searchParams));
  const paginationScope = `${JSON.stringify(applied)}\n${timezone}`;
  const activityPages = useCursorPages(paginationScope);
  const [cursorPaging, setCursorPaging] = useState<{
    readonly scope: string;
    readonly cursors: readonly (string | null)[];
  }>({ scope: "", cursors: [null] });
  const cursorHistory = cursorPaging.scope === paginationScope ? cursorPaging.cursors : [null];
  const currentCursor = cursorHistory.at(-1) ?? null;
  const page = cursorHistory.length;
  const [selected, setSelected] = useState<UsageRow | null>(null);
  const [exportPending, setExportPending] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const users = useUserLabelMap(true);
  const catalog = useAnalysisCatalog("usage");
  const reportFilters = useMemo(
    () => ({
      ...reportParameters(applied, new Date(), true, true, 100),
      timezone,
    }),
    [applied, timezone],
  );
  const parameters = useMemo(() => {
    const result: Record<string, string | number | readonly string[]> = {
      ...reportFilters,
      page_size: 25,
      ...(currentCursor === null ? {} : { cursor: currentCursor }),
    };
    return result;
  }, [currentCursor, reportFilters]);
  const report = useControlQuery<ReportEnvelope<unknown>>(
    ["usage-details", applicationSlug, parameters],
    applicationApiPath(applicationSlug, "/reports/usage"),
    parameters,
    { retry: false },
  );
  const activityParameters = useMemo(
    () => ({
      ...reportFilters,
      ...(activityPages.cursor === null ? {} : { cursor: activityPages.cursor }),
    }),
    [activityPages.cursor, reportFilters],
  );
  const activity = useControlQuery<ReportEnvelope<ActivityReport>>(
    ["usage-activity", applicationSlug, activityParameters],
    applicationApiPath(applicationSlug, "/reports/activity"),
    activityParameters,
    { retry: false },
  );
  const activityData = activity.data?.data;
  const metricLabel =
    analysisMetrics("usage").find((metric) => metric.value === applied.metric)?.label ?? "指标";
  const rows = normalizeCursorPage<UsageRow>(report.data?.data);
  const userLabel = (id: string | null) => (id ? (users.get(id) ?? "未识别用户") : "未关联用户");
  const columns: DataColumn<UsageRow>[] = [
    {
      key: "event_time",
      label: "时间",
      cell: (row) => dateTime(row.event_time, timezone, locale),
      exportValue: (row) => dateTime(row.event_time, timezone, locale),
    },
    {
      key: "user_id",
      label: "用户",
      cell: (row) => row.display_user ?? userLabel(row.user_id),
      exportValue: (row) => row.display_user ?? userLabel(row.user_id),
    },
    {
      key: "model",
      label: "模型",
      cell: (row) => row.virtual_model || row.model_tag,
      exportValue: (row) => row.virtual_model || row.model_tag,
    },
    { key: "status", label: "结果", cell: (row) => <StatusBadge value={row.status} /> },
    {
      key: "provider_cost_amount",
      label: "模型花费",
      cell: usageCost,
      exportValue: usageCost,
    },
    {
      key: "aiu_micros",
      label: "AIU",
      cell: (row) => formatAiuMicros(row.aiu_micros, locale),
      exportValue: (row) => formatAiuMicros(row.aiu_micros, locale),
    },
  ];
  const activityColumns: DataColumn<ActivityPoint>[] = [
    {
      key: "group",
      label: analysisGroupLabel(applied.group),
      cell: (point) =>
        applied.group.kind === "builtin" && applied.group.dimension === "user_id"
          ? userLabel(point.key)
          : point.key || "未填写",
    },
    {
      key: "value",
      label: metricLabel,
      cell: (point) => metricValue(point.value, activityData?.metric ?? "requests", locale),
    },
  ];
  return (
    <main className="page">
      <PageHeading
        title="调用明细"
        description="查看筛选范围内的模型调用、花费和 AIU。"
        actions={
          <Button asChild variant="outline">
            <Link href={`/apps/${encodeURIComponent(applicationSlug)}/costs`}>
              <ArrowLeft />
              返回模型花费
            </Link>
          </Button>
        }
      />
      <PermissionBoundary permission="reports:read">
        <AnalysisBuilder
          kind="usage"
          value={draft}
          onChange={setDraft}
          onLoad={(selection) => {
            setDraft(selection);
            setApplied(selection);
          }}
          onRun={() => {
            if (applied === draft) {
              void Promise.all([report.refetch(), activity.refetch()]);
            } else {
              setApplied(draft);
            }
            setCursorPaging({ scope: "", cursors: [null] });
          }}
          onExport={() => {
            setExportPending(true);
            setExportError(null);
            void controlDownload(
              applicationApiPath(applicationSlug, "/reports/usage/export") ?? "",
              reportFilters,
              analysisFileName("usage"),
            )
              .catch((error: unknown) => {
                setExportError(error instanceof Error ? error.message : "导出失败，请稍后重试。");
              })
              .finally(() => setExportPending(false));
          }}
          exportDisabled={!report.isSuccess || rows.total === 0}
          exportLabel="导出全部筛选结果"
          exportPending={exportPending}
          pending={report.isFetching || activity.isFetching}
        />
        {exportError ? (
          <p className="text-sm text-destructive" role="alert">
            {exportError}
          </p>
        ) : null}
        {activity.isPending ? <PageState state="loading" /> : null}
        {activity.isError ? (
          <PageState
            state="error"
            message="指标分析暂时不可用，请稍后重试。"
            onRetry={() => void activity.refetch()}
          />
        ) : null}
        {activity.isSuccess ? (
          <div className="grid gap-4">
            <MetricCard
              label={metricLabel}
              value={metricValue(activityData?.total, activityData?.metric ?? "requests", locale)}
              description="当前时间和筛选条件下的总量"
            />
            <Card>
              <CardHeader>
                <CardTitle>{metricLabel}趋势</CardTitle>
              </CardHeader>
              <CardContent>
                {(activityData?.trend.length ?? 0) > 0 ? (
                  <ActivityTrendChart
                    points={activityData!.trend}
                    label={metricLabel}
                    unit={activityData?.unit ?? "calls"}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">当前条件下没有趋势数据。</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>按{analysisGroupLabel(applied.group)}查看</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                <DataTable
                  columns={activityColumns}
                  rows={[...(activityData?.groups ?? [])]}
                  emptyMessage="当前条件下没有分组结果。"
                  showExport={false}
                  onRowClick={(point) => {
                    const next = selectionForGroupDrill(applied, catalog.propertyFields, point.key);
                    if (next === null) return;
                    setDraft(next);
                    setApplied(next);
                    setCursorPaging({ scope: "", cursors: [null] });
                  }}
                />
                <CursorPager
                  page={activityPages.page}
                  hasNext={activityData?.next_cursor !== null}
                  onPrevious={activityPages.previous}
                  onNext={() => {
                    if (activityData?.next_cursor) activityPages.next(activityData.next_cursor);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  共 {activityData?.total_groups ?? 0} 个分组
                </p>
              </CardContent>
            </Card>
          </div>
        ) : null}
        {report.isPending ? <PageState state="loading" /> : null}
        {report.isError ? (
          <PageState
            state="error"
            message="分析服务暂时不可用，请稍后重试或联系管理员。"
            onRetry={() => void report.refetch()}
          />
        ) : null}
        {report.isSuccess ? (
          <DataTable
            columns={columns}
            exportFileName="调用明细"
            rows={[...rows.items]}
            onRowClick={setSelected}
            emptyMessage="当前条件下没有调用记录。"
            pagination={{
              page,
              pageSize: rows.page_size,
              total: rows.total,
              hasNext: rows.next_cursor !== null,
              onPageChange: (nextPage) => {
                setCursorPaging((current) => {
                  const cursors = current.scope === paginationScope ? current.cursors : [null];
                  if (nextPage < cursors.length) {
                    return {
                      scope: paginationScope,
                      cursors: cursors.slice(0, Math.max(nextPage, 1)),
                    };
                  }
                  if (nextPage === cursors.length + 1 && rows.next_cursor !== null) {
                    return {
                      scope: paginationScope,
                      cursors: [...cursors, rows.next_cursor],
                    };
                  }
                  return { scope: paginationScope, cursors };
                });
              },
            }}
          />
        ) : null}
      </PermissionBoundary>
      {selected ? (
        <UsageDetailSheet
          onClose={() => setSelected(null)}
          propertyFields={catalog.propertyFields}
          row={selected}
          timezone={timezone}
          userLabel={userLabel}
        />
      ) : null}
    </main>
  );
}

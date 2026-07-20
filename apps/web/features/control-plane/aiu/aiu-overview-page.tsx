"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Gauge, Users } from "lucide-react";
import { useSearchParams } from "next/navigation";
import {
  applicationApiPath,
  useCurrentApplicationSlug,
} from "@/features/applications/use-current-application";

import { MetricCard } from "@/components/metric-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CursorPager } from "@/features/shared/components/cursor-pager";
import { PageHeading } from "@/features/shared/components/page-heading";
import { PageState } from "@/features/shared/components/page-state";
import { PermissionBoundary } from "@/features/shared/components/permission-boundary";
import { useCursorPages } from "@/features/shared/hooks/use-cursor-pages";
import { useLocale } from "@/i18n/locale-provider";
import { translateText, type AppLocale } from "@/i18n/translator";
import { useControlQuery } from "../api/hooks";
import type { ApplicationUserSummary, ReportEnvelope } from "../api/types";
import { useAnalysisCatalog, useUserLabelMap } from "../usage/analysis-options";
import { AnalysisBuilder } from "../usage/analysis-builder";
import {
  analysisFileName,
  analysisGroupLabel,
  analysisSelectionFromSearch,
  reportParameters,
  rowsToCsv,
  selectionForGroupDrill,
  selectionToDefinition,
  type AnalysisSelection,
} from "../usage/analysis-config";
import { AiuGroupResults } from "./aiu-group-results";
import { aiuGroupLabel, formatAiuMicros, type AiuGroupRow } from "./aiu-group-values";

interface AiuValue {
  readonly micros: string;
}

interface AiuReport {
  readonly total?: AiuValue | null;
  readonly unrated_events?: number;
  readonly unmapped_events?: number;
  readonly group_dimension?: string;
  readonly groups?: readonly AiuGroupRow[];
  readonly page_size?: number;
  readonly total_groups?: number;
  readonly next_cursor?: string | null;
}

function formatAiu(value: AiuValue | null | undefined, locale: AppLocale): string {
  return formatAiuMicros(value?.micros, locale);
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

function AiuSummary({
  report,
  quota,
  showQuota,
  showUsage,
}: Readonly<{
  report: AiuReport | undefined;
  quota: ApplicationUserSummary | undefined;
  showQuota: boolean;
  showUsage: boolean;
}>) {
  const { locale, text } = useLocale();
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {showUsage ? (
        <MetricCard
          label="AIU 用量"
          value={formatAiu(report?.total, locale)}
          description="所选时间内的模型调用用量"
          icon={<Gauge className="size-5" />}
        />
      ) : null}
      {showQuota ? (
        <>
          <MetricCard
            label="本周期额度"
            value={formatAiuMicros(quota?.limit_aiu_micros, locale)}
            description={`${quota?.total_users ?? "-"} ${text(
              "位用户当前额度合计",
              "users' combined allowance for the current period",
            )}`}
          />
          <MetricCard
            label="本周期已使用"
            value={formatAiuMicros(quota?.used_aiu_micros, locale)}
            description="所有用户当前周期合计"
          />
          <MetricCard
            label="用户剩余"
            value={formatAiuMicros(quota?.remaining_aiu_micros, locale)}
            description="已扣除正在处理的调用"
            icon={<Users className="size-5" />}
          />
        </>
      ) : null}
    </div>
  );
}

export function AiuOverviewPage() {
  const { locale, text } = useLocale();
  const applicationSlug = useCurrentApplicationSlug();
  const search = useSearchParams();
  const [draft, setDraft] = useState<AnalysisSelection>(() =>
    analysisSelectionFromSearch("aiu", search),
  );
  const [applied, setApplied] = useState<AnalysisSelection>(() =>
    analysisSelectionFromSearch("aiu", search),
  );
  const cursorPages = useCursorPages(JSON.stringify(applied));
  const catalog = useAnalysisCatalog("aiu");
  const parameters = useMemo(
    () => ({
      ...reportParameters(applied, new Date(), true, true, 200),
      ...(cursorPages.cursor === null ? {} : { cursor: cursorPages.cursor }),
    }),
    [applied, cursorPages.cursor],
  );
  const report = useControlQuery<ReportEnvelope<AiuReport>>(
    ["aiu-analysis", applicationSlug, applied, cursorPages.cursor],
    applicationApiPath(applicationSlug, "/reports/aiu"),
    parameters,
    { retry: false },
  );
  const quota = useControlQuery<ApplicationUserSummary>(
    ["application-user-summary", applicationSlug],
    applicationApiPath(applicationSlug, "/users/summary"),
    undefined,
    { retry: false },
  );
  const data = report.data?.data;
  const userGroup = applied.group.kind === "builtin" && applied.group.dimension === "user_id";
  const timeGroup = applied.group.kind === "builtin" && applied.group.dimension === "time";
  const userLabels = useUserLabelMap(userGroup);
  const groups = [...(data?.groups ?? [])].sort((left, right) =>
    timeGroup ? left.key.localeCompare(right.key) : 0,
  );
  const exportRows = groups.map((row) => ({
    [text("分组", "Group")]:
      applied.group.kind === "property"
        ? analysisGroupLabel(applied.group)
        : translateText(analysisGroupLabel(applied.group), locale),
    [text("名称", "Name")]: aiuGroupLabel(row, applied.group, applied.grain, userLabels, locale),
    [text("AIU 用量", "AIU usage")]: formatAiuMicros(row.aiu_micros, locale),
  }));

  return (
    <main className="page">
      <PageHeading title="AIU 分析" description="查看 AIU 用量，以及用户已使用和剩余额度。" />
      <PermissionBoundary permission="reports:read">
        <div className="grid gap-5">
          {quota.isError ? (
            <PageState
              state="partial"
              message="用户额度暂时不可用，AIU 用量统计不受影响。"
              onRetry={() => void quota.refetch()}
            />
          ) : null}
          <Tabs defaultValue="dashboard" className="grid gap-5">
            <TabsList aria-label="AIU 分析页面">
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
              {report.isSuccess || quota.isSuccess ? (
                <>
                  <AiuSummary
                    report={data}
                    quota={quota.data}
                    showQuota={quota.isSuccess}
                    showUsage={report.isSuccess}
                  />
                  {report.isSuccess &&
                  ((data?.unrated_events ?? 0) > 0 || (data?.unmapped_events ?? 0) > 0) ? (
                    <Alert>
                      <AlertDescription>
                        {data?.unrated_events ?? 0} 条调用尚未计算 AIU，{data?.unmapped_events ?? 0}
                        条调用尚未识别模型。配置完成后会自动纳入统计。
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  {quota.isSuccess ? (
                    <Card>
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <AlertTriangle className="size-5" /> 用户额度
                        </CardTitle>
                        <CardDescription>当前周期汇总，详细名单请前往用户额度。</CardDescription>
                      </CardHeader>
                      <CardContent className="grid gap-3 sm:grid-cols-3">
                        <div className="rounded-lg border p-4">
                          <div className="text-sm text-muted-foreground">正在处理</div>
                          <div className="mt-2 text-2xl font-semibold tabular-nums">
                            {formatAiuMicros(quota.data.reserved_aiu_micros, locale)}
                          </div>
                        </div>
                        <div className="rounded-lg border p-4">
                          <div className="text-sm text-muted-foreground">用户</div>
                          <div className="mt-2 text-2xl font-semibold tabular-nums">
                            {quota.data.total_users} 人
                          </div>
                        </div>
                        <div className="rounded-lg border p-4">
                          <div className="text-sm text-muted-foreground">已停止调用</div>
                          <div className="mt-2 text-2xl font-semibold tabular-nums">
                            {quota.data.blocked_users} 人
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ) : null}
                </>
              ) : null}
            </TabsContent>

            <TabsContent value="analysis" className="grid gap-5">
              <AnalysisBuilder
                kind="aiu"
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
                exportDisabled={exportRows.length === 0}
                onExport={() => downloadCsv(rowsToCsv(exportRows), analysisFileName("aiu"))}
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
                  <AiuSummary report={data} quota={undefined} showQuota={false} showUsage />
                  <AiuGroupResults
                    groups={groups}
                    group={applied.group}
                    grain={applied.grain}
                    totalGroups={data?.total_groups ?? groups.length}
                    userLabels={userLabels}
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
                </>
              ) : null}
            </TabsContent>
          </Tabs>
        </div>
      </PermissionBoundary>
    </main>
  );
}

"use client";

import Decimal from "decimal.js";
import { ArrowRight, CircleCheck } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";

import { useInstanceTimezone } from "@/components/instance-timezone";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeading } from "@/features/shared/components/page-heading";
import { PageState } from "@/features/shared/components/page-state";
import { PermissionBoundary } from "@/features/shared/components/permission-boundary";
import { reportRange } from "@/lib/api";
import { useLocale } from "@/i18n/locale-provider";
import type { AppLocale } from "@/i18n/translator";
import {
  applicationApiPath,
  useCurrentApplicationSlug,
} from "@/features/applications/use-current-application";
import { useControlQuery } from "../api/hooks";
import type { ApplicationUserSummary, OverviewReport, ReportEnvelope } from "../api/types";
import { formatAiuMicros } from "../quota/aiu-values";
import { OverviewCard } from "./overview-card";
import { RequestTrendChart } from "./request-trend-chart";
import { SavedDashboard } from "@/features/reports/saved-dashboard";

interface AiuHomeReport {
  readonly total?: { readonly micros?: string; readonly display?: string } | null;
  readonly unrated_events?: number;
}

const dashboardRanges = [
  ["24h", "24 小时"],
  ["7d", "7 天"],
  ["30d", "30 天"],
  ["90d", "90 天"],
] as const;

function amount(metric: OverviewReport["provider_cost"], locale: AppLocale): string {
  if (!metric) return "-";
  if (metric.display) return metric.display;
  if (!metric.currency) return metric.value;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: metric.currency,
      maximumFractionDigits: 6,
    }).format(new Decimal(metric.value).toNumber());
  } catch {
    return `${metric.currency} ${metric.value}`;
  }
}

function aiuAmount(
  report: AiuHomeReport | undefined,
  overview: OverviewReport | undefined,
  locale: AppLocale,
): string {
  const metric = report?.total;
  if (metric?.display) return metric.display;
  if (metric?.micros) return formatAiuMicros(metric.micros, locale);
  return overview?.aiu?.display ?? "-";
}

function tokenAmount(value: string | undefined, locale: AppLocale): string {
  if (value === undefined) return "-";
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
      new Decimal(value).toNumber(),
    );
  } catch {
    return value;
  }
}

function usageIssueHref(
  applicationPath: string,
  range: string,
  field: "cost_status" | "aiu_status" | "model_id",
  operator: "equals" | "is_not_set",
  values: readonly string[] = [],
): string {
  const search = new URLSearchParams({
    range,
    conditions: JSON.stringify([{ kind: "builtin", field, operator, values }]),
  });
  return `${applicationPath}/usage?${search.toString()}`;
}

export function DashboardPage() {
  const { locale, text } = useLocale();
  const search = useSearchParams();
  const applicationSlug = useCurrentApplicationSlug();
  const applicationPath = `/apps/${applicationSlug}`;
  const timezone = useInstanceTimezone();
  const requestedRange = search.get("range");
  const selectedRange = dashboardRanges.some(([value]) => value === requestedRange)
    ? requestedRange!
    : "24h";
  const range = useMemo(() => reportRange(selectedRange), [selectedRange]);
  const overviewReport = useControlQuery<ReportEnvelope<OverviewReport>>(
    ["overview", applicationSlug, selectedRange, timezone],
    applicationApiPath(applicationSlug, "/reports/overview"),
    { ...range, timezone },
    { retry: false },
  );
  const aiu = useControlQuery<ReportEnvelope<AiuHomeReport>>(
    ["aiu-report", "home", applicationSlug, selectedRange, timezone],
    applicationApiPath(applicationSlug, "/reports/aiu"),
    { ...range, timezone },
    { retry: false },
  );
  const users = useControlQuery<ApplicationUserSummary>(
    ["application-user-summary", applicationSlug],
    applicationApiPath(applicationSlug, "/users/summary"),
    undefined,
    { retry: false },
  );
  if (overviewReport.isPending) {
    return (
      <main className="page">
        <PageHeading title="首页" description="正在读取概览。" />
        <PageState state="loading" />
      </main>
    );
  }
  if (overviewReport.isError) {
    return (
      <main className="page">
        <PageHeading title="首页" description="查看模型花费、AIU 用量和需要处理的配置。" />
        <PermissionBoundary permission="reports:read">
          <PageState
            state="error"
            message="统计服务暂时不可用，请稍后重试或联系管理员。"
            onRetry={() => void overviewReport.refetch()}
          />
        </PermissionBoundary>
      </main>
    );
  }
  const overview = overviewReport.data.data;
  const issues = [
    {
      count: overview?.unpriced_events ?? 0,
      label: "条调用还没有成本价格",
      href: usageIssueHref(applicationPath, selectedRange, "cost_status", "equals", ["unpriced"]),
    },
    {
      count: overview?.unmapped_events ?? 0,
      label: "条调用还没有识别出真实模型",
      href: usageIssueHref(applicationPath, selectedRange, "model_id", "is_not_set"),
    },
    {
      count: aiu.data?.data.unrated_events ?? 0,
      label: "条调用还没有计算 AIU",
      href: usageIssueHref(applicationPath, selectedRange, "aiu_status", "is_not_set"),
    },
  ].filter((issue) => issue.count > 0);
  return (
    <main className="page">
      <PageHeading
        title="首页"
        description="查看模型花费、AIU 用量和需要处理的配置。"
        actions={
          <div className="flex flex-wrap gap-1">
            {dashboardRanges.map(([value, label]) => (
              <Button
                asChild
                key={value}
                size="sm"
                variant={selectedRange === value ? "default" : "outline"}
              >
                <Link href={`${applicationPath}?range=${value}`}>{label}</Link>
              </Button>
            ))}
          </div>
        }
      />
      <PermissionBoundary permission="reports:read">
        <div className="grid gap-5">
          {aiu.isError ? (
            <PageState
              state="partial"
              message="AIU 统计暂时不可用，请确认数据存储连接后重试。"
              onRetry={() => void aiu.refetch()}
            />
          ) : null}
          {users.isError ? (
            <PageState
              state="partial"
              message="用户额度暂时不可用，模型花费和 AIU 用量统计不受影响。"
              onRetry={() => void users.refetch()}
            />
          ) : null}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,11.5rem),1fr))] gap-4">
            <OverviewCard
              label="Token"
              value={tokenAmount(overview?.total_tokens, locale)}
              detail={`${overview?.requests ?? "-"} ${text("次调用", "calls")}`}
              href={`${applicationPath}/usage?range=${selectedRange}`}
            />
            <OverviewCard
              label="模型花费"
              value={amount(overview?.provider_cost, locale)}
              detail={`${overview?.requests ?? "-"} ${text("次调用", "calls")}`}
              href={`${applicationPath}/costs?range=${selectedRange}`}
            />
            <OverviewCard
              label="AIU 用量"
              value={aiu.isError ? "不可用" : aiuAmount(aiu.data?.data, overview, locale)}
              href={`${applicationPath}/ai-units?range=${selectedRange}`}
            />
            <OverviewCard
              label="用户剩余 AIU"
              value={
                users.isSuccess ? formatAiuMicros(users.data.remaining_aiu_micros, locale) : "-"
              }
              detail="当前周期，已扣除正在处理的调用"
              href={`${applicationPath}/users`}
            />
            <OverviewCard
              label="用户"
              value={users.isSuccess ? String(users.data.total_users) : "-"}
              detail={
                users.isSuccess
                  ? `${users.data.blocked_users} ${text("位已停止调用", "users have stopped calls")}`
                  : text("当前应用", "Current application")
              }
              href={`${applicationPath}/users`}
            />
          </div>
          <Card>
            <CardHeader>
              <CardTitle>调用趋势</CardTitle>
            </CardHeader>
            <CardContent>
              {overview?.request_trend?.length ? (
                <RequestTrendChart points={overview.request_trend} />
              ) : (
                <p className="text-sm text-muted-foreground">当前时间范围还没有调用。</p>
              )}
            </CardContent>
          </Card>
          <SavedDashboard />
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>需要处理</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                {issues.length === 0 ? (
                  <div className="flex items-start gap-3 rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
                    <CircleCheck
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0 text-[var(--mint-strong)]"
                    />
                    <span>当前没有发现需要立即处理的问题。</span>
                  </div>
                ) : (
                  issues.map((issue) => (
                    <Alert key={`${issue.href}-${issue.label}`}>
                      <AlertTitle>
                        {issue.count} {issue.label}
                      </AlertTitle>
                      <AlertDescription>
                        <Button asChild className="mt-2" size="sm" variant="outline">
                          <Link href={issue.href}>查看并处理</Link>
                        </Button>
                      </AlertDescription>
                    </Alert>
                  ))
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>配置流程</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-1">
                {(
                  [
                    [
                      "录入模型和价格",
                      "填写 LiteLLM 名称、模型花费与 AIU 单价",
                      `${applicationPath}/models`,
                    ],
                    [
                      "配置虚拟模型",
                      "设置默认模型、时段和失败顺序",
                      `${applicationPath}/virtual-models`,
                    ],
                    ["发布调用配置", "检查后下发当前策略", `${applicationPath}/releases`],
                    ["检查服务连接", "确认 LiteLLM 正常接收配置", `${applicationPath}/connectors`],
                  ] as const
                ).map(([title, description, href]) => (
                  <Link
                    className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                    href={href}
                    key={href}
                  >
                    <span className="min-w-0 flex-1">
                      <strong className="block text-sm font-medium">{title}</strong>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {description}
                      </span>
                    </span>
                    <ArrowRight
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                    />
                  </Link>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>
      </PermissionBoundary>
    </main>
  );
}

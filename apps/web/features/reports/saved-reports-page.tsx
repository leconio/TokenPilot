"use client";

import { LayoutDashboard, LayoutDashboardIcon, Trash2 } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { useInstanceTimezone } from "@/components/instance-timezone";
import { DataTable, type DataColumn } from "@/features/shared/components/data-table";
import { PageHeading } from "@/features/shared/components/page-heading";
import { PageState } from "@/features/shared/components/page-state";
import {
  applicationApiPath,
  useCurrentApplicationSlug,
} from "@/features/applications/use-current-application";
import { useLocale } from "@/i18n/locale-provider";
import { dateTime } from "@/lib/format";
import { useControlMutation, useControlQuery } from "../control-plane/api/hooks";
import type { InstanceCapabilities } from "../control-plane/api/types";
import type { AnalysisKind, SavedReportDefinition } from "../control-plane/usage/analysis-config";

interface SavedReport {
  readonly id: string;
  readonly name: string;
  readonly kind: AnalysisKind;
  readonly definition: SavedReportDefinition;
  readonly updated_at: string;
}

interface DashboardCard {
  readonly id: string;
  readonly report: SavedReport;
}

const kindLabels: Readonly<Record<AnalysisKind, string>> = {
  usage: "调用明细",
  cost: "模型花费",
  aiu: "AIU 用量",
};

function reportHref(applicationSlug: string, report: SavedReport): string {
  const page = report.kind === "aiu" ? "ai-units" : report.kind === "cost" ? "costs" : "usage";
  return `/apps/${applicationSlug}/${page}?saved_report=${encodeURIComponent(report.id)}`;
}

export function SavedReportsPage() {
  const { locale, text } = useLocale();
  const applicationSlug = useCurrentApplicationSlug();
  const timezone = useInstanceTimezone();
  const reportsPath = applicationApiPath(applicationSlug, "/reports/saved") ?? "";
  const dashboardPath = applicationApiPath(applicationSlug, "/reports/dashboard") ?? "";
  const reports = useControlQuery<{ reports: readonly SavedReport[] }>(
    ["saved-reports", applicationSlug],
    reportsPath || null,
    undefined,
    { retry: false },
  );
  const dashboard = useControlQuery<{ cards: readonly DashboardCard[] }>(
    ["dashboard-reports", applicationSlug],
    dashboardPath || null,
    undefined,
    { retry: false },
  );
  const access = useControlQuery<InstanceCapabilities>(
    ["application-capabilities", applicationSlug],
    applicationApiPath(applicationSlug, "/capabilities"),
  );
  const canWrite =
    access.data?.permissions?.includes("admin:write") === true ||
    access.data?.permissions?.includes("*") === true;
  const add = useControlMutation<DashboardCard, { report_id: string }>(dashboardPath, "POST", [
    "dashboard-reports",
  ]);
  const removeCard = useControlMutation<{ deleted: true }, { id: string }>(
    (body) => `${dashboardPath}/${body.id}`,
    "DELETE",
    ["dashboard-reports"],
  );
  const removeReport = useControlMutation<{ deleted: true }, { id: string }>(
    (body) => `${reportsPath}/${body.id}`,
    "DELETE",
    ["saved-reports", "dashboard-reports"],
  );
  const cardsByReport = new Map(
    (dashboard.data?.cards ?? []).map((card) => [card.report.id, card]),
  );
  const columns: DataColumn<SavedReport>[] = [
    {
      key: "name",
      label: "报表",
      cell: (report) => (
        <div>
          <strong data-i18n-skip>{report.name}</strong>
          <div className="text-xs text-muted-foreground">{kindLabels[report.kind]}</div>
        </div>
      ),
    },
    {
      key: "range",
      label: "时间",
      cell: (report) =>
        ({ "24h": "最近 24 小时", "7d": "最近 7 天", "30d": "最近 30 天", "90d": "最近 90 天" })[
          report.definition.range
        ],
    },
    {
      key: "updated_at",
      label: "更新于",
      cell: (report) => dateTime(report.updated_at, timezone, locale),
    },
    {
      key: "actions",
      label: "",
      cell: (report) => {
        const card = cardsByReport.get(report.id);
        return (
          <div className="flex flex-wrap justify-end gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href={reportHref(applicationSlug, report)}>打开</Link>
            </Button>
            {canWrite && card ? (
              <Button
                size="sm"
                variant="outline"
                disabled={removeCard.isPending}
                onClick={() => removeCard.mutate({ id: card.id })}
              >
                <LayoutDashboardIcon /> 从首页移除
              </Button>
            ) : canWrite ? (
              <Button
                size="sm"
                variant="outline"
                disabled={add.isPending}
                onClick={() => add.mutate({ report_id: report.id })}
              >
                <LayoutDashboard /> 放到首页
              </Button>
            ) : null}
            {canWrite ? (
              <Button
                size="icon"
                variant="ghost"
                aria-label={text(`删除报表 ${report.name}`, `Delete report ${report.name}`)}
                disabled={removeReport.isPending}
                onClick={() => removeReport.mutate({ id: report.id })}
              >
                <Trash2 />
              </Button>
            ) : null}
          </div>
        );
      },
    },
  ];
  return (
    <main className="page">
      <PageHeading title="报表" description="保存常用筛选条件，并把重要结果放到本应用首页。" />
      {access.isSuccess && !canWrite ? (
        <p className="text-sm text-muted-foreground">当前账号可查看报表，但不能修改或删除。</p>
      ) : null}
      {add.isError || removeCard.isError || removeReport.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {(add.error ?? removeCard.error ?? removeReport.error)?.message}
        </p>
      ) : null}
      {reports.isPending || dashboard.isPending ? <PageState state="loading" /> : null}
      {reports.isError || dashboard.isError ? (
        <PageState
          state="error"
          message="报表暂时无法读取，请稍后重试。"
          onRetry={() => void Promise.all([reports.refetch(), dashboard.refetch()])}
        />
      ) : null}
      {reports.isSuccess && dashboard.isSuccess ? (
        <DataTable
          rows={[...(reports.data.reports ?? [])]}
          columns={columns}
          emptyMessage="还没有保存报表。请在模型花费、AIU 分析或调用明细中组合条件后保存。"
          showExport={false}
        />
      ) : null}
    </main>
  );
}

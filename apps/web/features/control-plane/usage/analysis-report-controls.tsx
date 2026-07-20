"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, FolderOpen, LayoutDashboard, Save, Search } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  applicationApiPath,
  useCurrentApplicationSlug,
} from "@/features/applications/use-current-application";
import { useLocale } from "@/i18n/locale-provider";
import { translateText } from "@/i18n/translator";
import { controlMutate } from "../api/client";
import { useControlQuery } from "../api/hooks";
import type { InstanceCapabilities } from "../api/types";
import {
  analysisRanges,
  selectionFromDefinition,
  selectionToDefinition,
  type AnalysisFieldDefinition,
  type AnalysisKind,
  type AnalysisSelection,
  type SavedReportDefinition,
} from "./analysis-config";

interface SavedReport {
  readonly id: string;
  readonly name: string;
  readonly kind: AnalysisKind;
  readonly definition: SavedReportDefinition;
}

interface ReportNotice {
  readonly name: string;
  readonly kind: "loaded" | "saved" | "saved-to-dashboard";
}

export function AnalysisReportControls({
  kind,
  value,
  propertyFields,
  incomplete,
  pending,
  onChange,
  onLoad,
  onRun,
  onExport,
  exportDisabled,
  exportLabel,
  exportPending,
  showExport,
}: Readonly<{
  kind: AnalysisKind;
  value: AnalysisSelection;
  propertyFields: readonly AnalysisFieldDefinition[];
  incomplete: boolean;
  pending: boolean;
  onChange: (value: AnalysisSelection) => void;
  onLoad?: ((value: AnalysisSelection) => void) | undefined;
  onRun: () => void;
  onExport: () => void;
  exportDisabled: boolean;
  exportLabel: string;
  exportPending: boolean;
  showExport: boolean;
}>) {
  const applicationSlug = useCurrentApplicationSlug();
  const { locale, text } = useLocale();
  const requestedReportId = useSearchParams().get("saved_report");
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<ReportNotice | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [addToDashboard, setAddToDashboard] = useState(true);
  const [loadedReportId, setLoadedReportId] = useState<string | null>(null);
  const savedPath = applicationApiPath(applicationSlug, "/reports/saved") ?? "";
  const dashboardPath = applicationApiPath(applicationSlug, "/reports/dashboard") ?? "";
  const saved = useControlQuery<{ readonly reports: readonly SavedReport[] }>(
    ["saved-reports", applicationSlug],
    savedPath || null,
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
  const canExport =
    kind !== "usage" ||
    access.data?.permissions?.includes("usage:read") === true ||
    access.data?.permissions?.includes("*") === true;
  const save = useMutation({
    mutationFn: async () => {
      const report = await controlMutate<SavedReport, unknown>(savedPath, {
        name: saveName,
        kind,
        definition: selectionToDefinition(value),
      });
      if (addToDashboard) {
        await controlMutate(dashboardPath, { report_id: report.id, width: 1 });
      }
      return report;
    },
    onSuccess: async (report) => {
      setSaveOpen(false);
      setNotice({ name: report.name, kind: addToDashboard ? "saved-to-dashboard" : "saved" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["saved-reports", applicationSlug] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-reports", applicationSlug] }),
      ]);
    },
  });
  const availableReports = (saved.data?.reports ?? []).filter((report) => report.kind === kind);

  useEffect(() => {
    if (requestedReportId === null || loadedReportId === requestedReportId) return;
    const report = availableReports.find((candidate) => candidate.id === requestedReportId);
    if (report === undefined) return;
    (onLoad ?? onChange)(selectionFromDefinition(report.definition, propertyFields));
    setLoadedReportId(report.id);
    setNotice({ name: report.name, kind: "loaded" });
  }, [availableReports, loadedReportId, onChange, onLoad, propertyFields, requestedReportId]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={onRun} disabled={pending || incomplete}>
          <Search /> {pending ? "查询中…" : "查询"}
        </Button>
        {canWrite ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              const kindName =
                kind === "aiu"
                  ? text("AIU 用量", "AIU usage")
                  : kind === "cost"
                    ? text("模型花费", "Model cost")
                    : text("调用明细", "Call details");
              const rangeName = translateText(
                analysisRanges.find((range) => range.value === value.range)?.label ?? value.range,
                locale,
              );
              setSaveName(`${kindName} · ${rangeName}`);
              setSaveOpen(true);
            }}
            disabled={incomplete}
          >
            <Save /> 保存报表
          </Button>
        ) : null}
        {availableReports.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline">
                <FolderOpen /> 已保存 ({availableReports.length})
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {availableReports.map((report) => (
                <DropdownMenuItem
                  key={report.id}
                  onSelect={() => {
                    (onLoad ?? onChange)(
                      selectionFromDefinition(report.definition, propertyFields),
                    );
                    setNotice({ name: report.name, kind: "loaded" });
                  }}
                >
                  <span data-i18n-skip>{report.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {showExport && canExport ? (
          <Button
            type="button"
            variant="outline"
            onClick={onExport}
            disabled={exportDisabled || exportPending}
          >
            <Download /> {exportPending ? "正在导出…" : exportLabel}
          </Button>
        ) : showExport && access.isSuccess ? (
          <span className="text-xs text-muted-foreground">当前账号没有导出权限。</span>
        ) : null}
        {notice ? (
          <span className="text-xs text-muted-foreground">
            {notice.kind === "loaded" ? text("已载入“", "Loaded “") : "“"}
            <span data-i18n-skip>{notice.name}</span>
            {notice.kind === "saved-to-dashboard"
              ? text("”已保存并添加到首页。", "” was saved and added to the dashboard.")
              : notice.kind === "saved"
                ? text("”已保存。", "” was saved.")
                : text("”。", "”.")}
          </span>
        ) : null}
      </div>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>保存报表</DialogTitle>
            <DialogDescription>保存后可在本应用内复用，也可以放到首页。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="saved-report-name">名称</Label>
              <Input
                id="saved-report-name"
                value={saveName}
                onChange={(event) => setSaveName(event.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={addToDashboard}
                onCheckedChange={(checked) => setAddToDashboard(checked === true)}
              />
              <LayoutDashboard className="size-4" />
              添加到应用首页
            </label>
            {save.isError ? <p className="text-sm text-destructive">{save.error.message}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>
              取消
            </Button>
            <Button
              disabled={saveName.trim().length === 0 || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

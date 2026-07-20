"use client";

import { Plus } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isAnalysisConditionComplete, newAnalysisCondition } from "./analysis-condition";
import { AnalysisConditionRow } from "./analysis-condition-row";
import {
  analysisGrains,
  analysisGroupLabel,
  analysisGroupValue,
  analysisMetrics,
  analysisRanges,
  conditionFieldId,
  type AnalysisKind,
  type AnalysisSelection,
} from "./analysis-config";
import { useAnalysisCatalog, useAnalysisOptions } from "./analysis-options";
import { AnalysisReportControls } from "./analysis-report-controls";

interface AnalysisBuilderProps {
  readonly kind: AnalysisKind;
  readonly value: AnalysisSelection;
  readonly onChange: (value: AnalysisSelection) => void;
  readonly onRun: () => void;
  readonly onLoad?: (value: AnalysisSelection) => void;
  readonly onExport: () => void;
  readonly exportDisabled?: boolean;
  readonly exportLabel?: string;
  readonly exportPending?: boolean;
  readonly showExport?: boolean;
  readonly pending?: boolean;
}

export function AnalysisBuilder({
  kind,
  value,
  onChange,
  onRun,
  onLoad,
  onExport,
  exportDisabled = false,
  exportLabel = "导出当前结果",
  exportPending = false,
  showExport = true,
  pending = false,
}: Readonly<AnalysisBuilderProps>) {
  const catalog = useAnalysisCatalog(kind);
  const activeFields = useMemo(
    () => new Set(value.conditions.map(conditionFieldId)),
    [value.conditions],
  );
  const options = useAnalysisOptions(activeFields);
  const incomplete = value.conditions.some((condition) => !isAnalysisConditionComplete(condition));
  const metrics = analysisMetrics(kind);

  function addCondition() {
    const first = catalog.fields[0];
    if (first === undefined || value.conditions.length >= 64) return;
    onChange({ ...value, conditions: [...value.conditions, newAnalysisCondition(first)] });
  }

  function changeRange(range: AnalysisSelection["range"]) {
    const grain =
      kind === "aiu" && (range === "30d" || range === "90d") && value.grain === "hour"
        ? "day"
        : value.grain;
    onChange({ ...value, range, grain });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>自助分析</CardTitle>
        <CardDescription>按时间、模型、用户或自定义字段组合查询。</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div
          className={`grid gap-4 sm:grid-cols-2 ${value.group.kind === "builtin" && value.group.dimension === "time" ? "xl:grid-cols-4" : metrics.length > 1 ? "xl:grid-cols-3" : "xl:grid-cols-2"}`}
        >
          <div className="grid min-w-0 gap-2">
            <Label>时间</Label>
            <Select
              value={value.range}
              onValueChange={(range) => changeRange(range as AnalysisSelection["range"])}
            >
              <SelectTrigger className="w-full" aria-label="统计时间">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {analysisRanges.map((range) => (
                  <SelectItem key={range.value} value={range.value}>
                    {range.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {metrics.length > 1 ? (
            <div className="grid min-w-0 gap-2">
              <Label>指标</Label>
              <Select
                value={value.metric}
                onValueChange={(metric) =>
                  onChange({ ...value, metric: metric as AnalysisSelection["metric"] })
                }
              >
                <SelectTrigger className="w-full" aria-label="统计指标">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {metrics.map((metric) => (
                    <SelectItem key={metric.value} value={metric.value}>
                      {metric.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="grid min-w-0 gap-2">
            <Label>分组</Label>
            <Select
              value={analysisGroupValue(value.group)}
              onValueChange={(selected) => {
                const group = catalog.groups.find(
                  (candidate) => analysisGroupValue(candidate) === selected,
                );
                if (group) onChange({ ...value, group });
              }}
            >
              <SelectTrigger className="w-full" aria-label="统计分组">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {catalog.groups.map((group) => (
                  <SelectItem key={analysisGroupValue(group)} value={analysisGroupValue(group)}>
                    {analysisGroupLabel(group)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {value.group.kind === "builtin" && value.group.dimension === "time" ? (
            <div className="grid min-w-0 gap-2">
              <Label>粒度</Label>
              <Select
                value={value.grain}
                onValueChange={(grain) =>
                  onChange({ ...value, grain: grain as AnalysisSelection["grain"] })
                }
              >
                <SelectTrigger className="w-full" aria-label="时间粒度">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {analysisGrains.map((grain) => (
                    <SelectItem
                      key={grain.value}
                      value={grain.value}
                      disabled={
                        grain.value === "hour" && (value.range === "30d" || value.range === "90d")
                      }
                    >
                      {grain.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>

        <div className="rounded-xl border bg-muted/20 p-3 sm:p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span>满足</span>
            <Select
              value={value.match}
              onValueChange={(match) =>
                onChange({ ...value, match: match as AnalysisSelection["match"] })
              }
            >
              <SelectTrigger className="w-24" aria-label="条件关系">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="any">任一</SelectItem>
              </SelectContent>
            </Select>
            <span>条件</span>
          </div>
          <div className="grid gap-3">
            {value.conditions.map((condition) => (
              <AnalysisConditionRow
                key={condition.id}
                condition={condition}
                fields={catalog.fields}
                options={options}
                onChange={(next) =>
                  onChange({
                    ...value,
                    conditions: value.conditions.map((item) => (item.id === next.id ? next : item)),
                  })
                }
                onRemove={() =>
                  onChange({
                    ...value,
                    conditions: value.conditions.filter((item) => item.id !== condition.id),
                  })
                }
              />
            ))}
            {value.conditions.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">当前统计全部数据。</p>
            ) : null}
            <div>
              <Button
                type="button"
                variant="outline"
                onClick={addCondition}
                disabled={catalog.fields.length === 0 || value.conditions.length >= 64}
              >
                <Plus /> 添加条件
              </Button>
            </div>
          </div>
        </div>

        <AnalysisReportControls
          kind={kind}
          value={value}
          propertyFields={catalog.propertyFields}
          incomplete={incomplete}
          pending={pending}
          onChange={onChange}
          onLoad={onLoad}
          onRun={onRun}
          onExport={onExport}
          exportDisabled={exportDisabled}
          exportLabel={exportLabel}
          exportPending={exportPending}
          showExport={showExport}
        />
      </CardContent>
    </Card>
  );
}

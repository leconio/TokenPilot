"use client";

import { AlertTriangle, Coins, Gauge, MessageSquare, Text } from "lucide-react";

import { MetricCard } from "@/components/metric-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { decimal } from "@/lib/format";
import { useLocale } from "@/i18n/locale-provider";
import type { ModelDefinition, ModelIssue } from "./types";

const roleLabels = { default: "默认模型", candidate: "候选模型", rule: "条件规则" } as const;
const issueLabels = {
  unresolved: "模型未识别",
  unpriced: "未统计花费",
  unrated: "未计算 AIU",
} as const;

function issueTime(value: string, locale: "zh-CN" | "en"): string {
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function IssueRow({ issue }: Readonly<{ issue: ModelIssue }>) {
  const { locale, text } = useLocale();
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap gap-1">
          {issue.types.map((type) => (
            <Badge key={type} variant="outline">
              {issueLabels[type]}
            </Badge>
          ))}
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {text(`调用 ${issue.event_id}`, `Call ${issue.event_id}`)}
        </p>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {issueTime(issue.occurred_at, locale)}
      </span>
    </div>
  );
}

export function ModelInsights({ model }: Readonly<{ model: ModelDefinition }>) {
  const { locale, text } = useLocale();
  const metrics = model.metrics;
  if (metrics === undefined) return null;
  const references = model.virtual_model_references ?? [];
  const issues = model.recent_issues ?? [];
  return (
    <section className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          description="已完成统计的模型调用"
          icon={<MessageSquare />}
          label="调用数"
          value={metrics.calls.toLocaleString(locale)}
        />
        <MetricCard
          description="该模型累计处理的 Token"
          icon={<Text />}
          label="Token"
          value={decimal(metrics.tokens, 0)}
        />
        <MetricCard
          description={text(
            `按当前应用的 ${metrics.currency} 汇总`,
            `Aggregated in this application's ${metrics.currency}`,
          )}
          icon={<Coins />}
          label="模型花费"
          value={`${metrics.currency} ${decimal(metrics.cost, 4)}`}
        />
        <MetricCard
          description="该模型累计折算的 AIU"
          icon={<Gauge />}
          label="AIU"
          value={decimal(metrics.aiu, 3)}
        />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>被虚拟模型使用</CardTitle>
            <CardDescription>停用前请确认这些调用关系。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {references.length === 0 ? (
              <p className="text-sm text-muted-foreground">当前没有虚拟模型使用它。</p>
            ) : (
              references.map((reference) => (
                <div className="rounded-lg border p-3" key={reference.id}>
                  <strong data-i18n-skip>{reference.display_name}</strong>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {reference.uses_as.map((role) => (
                      <Badge key={role} variant="outline">
                        {roleLabels[role]}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4" /> 最近问题
            </CardTitle>
            <CardDescription>优先检查上报金额、备用规则或模型名称。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {issues.length === 0 ? (
              <p className="text-sm text-muted-foreground">最近没有发现问题。</p>
            ) : (
              issues.map((issue) => (
                <IssueRow issue={issue} key={`${issue.event_id}-${issue.types.join("-")}`} />
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

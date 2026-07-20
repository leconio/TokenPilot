"use client";

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatAiuMicros } from "@/features/control-plane/quota/aiu-values";
import { PageState } from "@/features/shared/components/page-state";
import { useLocale } from "@/i18n/locale-provider";
import { dateTime, decimal } from "@/lib/format";

import type { ApplicationUser, UserAnalytics, UserLedgerEntry } from "./types";
import { UserActivityChart } from "./user-activity-chart";

function money(values: readonly { readonly currency: string; readonly amount: string }[]): string {
  return values.length === 0
    ? "-"
    : values.map((value) => `${value.currency} ${decimal(value.amount, 4)}`).join(" · ");
}

function operationLabel(action: string, zh: boolean): string {
  const labels: Readonly<Record<string, readonly [string, string]>> = {
    "user.create": ["添加用户", "User added"],
    "user.update": ["更新资料", "Profile updated"],
    "user.access.update": ["更改调用状态", "Access changed"],
    "user.quota.update": ["更新额度", "Quota updated"],
    "user.quota.reset": ["重置额度", "Quota reset"],
  };
  const value = labels[action];
  return value === undefined ? action.replaceAll("_", " ") : value[zh ? 0 : 1];
}

export function UserDetail({
  user,
  analytics,
  analyticsPending,
  analyticsError,
  onAnalyticsRetry,
  ledger,
  ledgerPending,
  ledgerError,
  onLedgerRetry,
  timezone,
  actions,
}: Readonly<{
  user: ApplicationUser;
  analytics?: UserAnalytics | undefined;
  analyticsPending: boolean;
  analyticsError: Error | null;
  onAnalyticsRetry: () => void;
  ledger?: readonly UserLedgerEntry[] | undefined;
  ledgerPending: boolean;
  ledgerError: Error | null;
  onLedgerRetry: () => void;
  timezone: string;
  actions: ReactNode;
}>) {
  const { locale, text } = useLocale();
  if (analyticsPending) return <PageState state="loading" />;
  if (analyticsError) {
    return <PageState state="error" message={analyticsError.message} onRetry={onAnalyticsRetry} />;
  }
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">{actions}</div>
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">{text("概览", "Overview")}</TabsTrigger>
          <TabsTrigger value="history">{text("调用记录", "Calls")}</TabsTrigger>
          <TabsTrigger value="quota">{text("额度记录", "Quota")}</TabsTrigger>
          <TabsTrigger value="operations">{text("操作记录", "Activity")}</TabsTrigger>
        </TabsList>
        <TabsContent className="grid gap-4" value="overview">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              [text("调用", "Calls"), String(user.usage.calls)],
              ["Token", decimal(user.usage.tokens, 0)],
              ["AIU", formatAiuMicros(user.usage.aiu_micros, locale)],
              [text("模型花费", "Model cost"), money(analytics?.costs ?? [])],
            ].map(([label, value]) => (
              <Card key={label}>
                <CardHeader>
                  <CardTitle className="text-sm">{label}</CardTitle>
                </CardHeader>
                <CardContent className="text-lg font-semibold">{value}</CardContent>
              </Card>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              [text("额度", "Quota"), user.quota.limit_aiu_micros],
              [text("已用", "Used"), user.quota.used_aiu_micros],
              [text("剩余", "Remaining"), user.quota.remaining_aiu_micros],
            ].map(([label, value]) => (
              <Card key={label}>
                <CardHeader>
                  <CardTitle className="text-sm">{label}</CardTitle>
                </CardHeader>
                <CardContent className="text-lg font-semibold">
                  {formatAiuMicros(value, locale)}
                </CardContent>
              </Card>
            ))}
          </div>
          <Card>
            <CardHeader>
              <CardTitle>{text("调用趋势", "Call trend")}</CardTitle>
            </CardHeader>
            <CardContent>
              {analytics?.trend.length ? (
                <UserActivityChart points={analytics.trend} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {text("暂无调用。", "No calls yet.")}
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{text("使用的模型", "Models used")}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {analytics?.models.length ? (
                analytics.models.map((model) => (
                  <div
                    className="grid gap-1 border-b py-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:gap-4"
                    key={`${model.virtual_model}:${model.request_model}`}
                  >
                    <span>
                      <strong>{model.request_model}</strong>
                      {model.virtual_model ? (
                        <small className="ml-2 text-muted-foreground">{model.virtual_model}</small>
                      ) : null}
                    </span>
                    <span>
                      {model.calls} {text("次", "calls")}
                    </span>
                    <span>{decimal(model.tokens, 0)} Token</span>
                    <span>{formatAiuMicros(model.aiu_micros, locale)}</span>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  {text("暂无模型用量。", "No model usage yet.")}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="history">
          <Card>
            <CardContent className="grid gap-2 pt-6">
              {analytics?.recent_calls.length ? (
                analytics.recent_calls.map((call) => (
                  <div
                    className="flex flex-wrap items-center justify-between gap-2 border-b py-2 text-sm"
                    key={call.event_id}
                  >
                    <span>
                      <strong>{call.virtual_model || call.request_model}</strong>
                      <small className="ml-2 text-muted-foreground">
                        {dateTime(call.event_time, timezone, locale)}
                      </small>
                    </span>
                    <Badge variant={call.status === "success" ? "outline" : "destructive"}>
                      {call.status === "success" ? text("成功", "Success") : text("失败", "Failed")}
                    </Badge>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  {text("暂无调用记录。", "No call history yet.")}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="quota">
          <Card>
            <CardContent className="pt-6">
              {ledgerPending ? (
                <PageState state="loading" />
              ) : ledgerError ? (
                <PageState state="error" message={ledgerError.message} onRetry={onLedgerRetry} />
              ) : ledger?.length ? (
                <div className="grid gap-2">
                  {ledger.map((entry) => (
                    <div
                      className="flex justify-between gap-3 border-b py-2 text-sm"
                      key={entry.id}
                    >
                      <span>{entry.reason ?? text("系统记录", "System record")}</span>
                      <span>{dateTime(entry.created_at, timezone, locale)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {text("暂无额度记录。", "No quota activity yet.")}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="operations">
          <Card>
            <CardContent className="grid gap-2 pt-6">
              {analytics?.operations.length ? (
                analytics.operations.map((operation) => (
                  <div
                    className="flex flex-wrap justify-between gap-2 border-b py-2 text-sm"
                    key={operation.id}
                  >
                    <span>
                      <strong>{operationLabel(operation.action, locale === "zh-CN")}</strong>
                      {operation.reason ? (
                        <small className="ml-2 text-muted-foreground">{operation.reason}</small>
                      ) : null}
                    </span>
                    <span>{dateTime(operation.created_at, timezone, locale)}</span>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  {text("暂无操作记录。", "No activity yet.")}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

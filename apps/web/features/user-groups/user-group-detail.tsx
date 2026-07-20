"use client";

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAiuMicros } from "@/features/control-plane/quota/aiu-values";
import { PageState } from "@/features/shared/components/page-state";
import { UserActivityChart } from "@/features/users/user-activity-chart";
import { useLocale } from "@/i18n/locale-provider";
import { decimal } from "@/lib/format";

import type { UserGroupMember } from "./types";

export interface GroupActivityReport {
  readonly total: string | null;
  readonly groups: readonly { readonly key: string; readonly value: string | null }[];
  readonly trend: readonly { readonly key: string; readonly value: string | null }[];
}

export interface GroupAiuReport {
  readonly total: { readonly micros: string } | null;
  readonly groups: readonly { readonly key: string; readonly aiu_micros: string }[];
}

export interface GroupCostReport {
  readonly totals: readonly { readonly value: string; readonly currency: string }[];
  readonly groups: readonly {
    readonly key: string;
    readonly amount: string;
    readonly currency: string;
  }[];
}

function money(values: GroupCostReport["totals"] | undefined): string {
  return values?.length
    ? values.map((value) => `${value.currency} ${decimal(value.value, 4)}`).join(" · ")
    : "-";
}

export function UserGroupDetail({
  memberCount,
  calls,
  tokens,
  aiu,
  costs,
  members,
  pending,
  error,
  onRetry,
  actions,
}: Readonly<{
  memberCount: number;
  calls?: GroupActivityReport | undefined;
  tokens?: GroupActivityReport | undefined;
  aiu?: GroupAiuReport | undefined;
  costs?: GroupCostReport | undefined;
  members?: readonly UserGroupMember[] | undefined;
  pending: boolean;
  error: Error | null;
  onRetry: () => void;
  actions: ReactNode;
}>) {
  const { locale, text } = useLocale();
  if (pending) return <PageState state="loading" />;
  if (error) return <PageState state="error" message={error.message} onRetry={onRetry} />;
  const aiuByModel = new Map((aiu?.groups ?? []).map((row) => [row.key, row.aiu_micros]));
  const costsByModel = new Map<string, string[]>();
  for (const row of costs?.groups ?? []) {
    costsByModel.set(row.key, [
      ...(costsByModel.get(row.key) ?? []),
      `${row.currency} ${decimal(row.amount, 4)}`,
    ]);
  }
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">{actions}</div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          [text("人数", "People"), String(memberCount)],
          [text("调用", "Calls"), calls?.total ?? "0"],
          ["Token", decimal(tokens?.total ?? "0", 0)],
          ["AIU", formatAiuMicros(aiu?.total?.micros ?? "0", locale)],
          [text("模型花费", "Model cost"), money(costs?.totals)],
        ].map(([label, value]) => (
          <Card key={label}>
            <CardHeader>
              <CardTitle className="text-sm">{label}</CardTitle>
            </CardHeader>
            <CardContent className="text-lg font-semibold">{value}</CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{text("调用趋势", "Call trend")}</CardTitle>
        </CardHeader>
        <CardContent>
          {calls?.trend.length ? (
            <UserActivityChart
              points={calls.trend.map((point) => ({
                bucket: point.key,
                calls: Number(point.value ?? 0),
              }))}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{text("暂无调用。", "No calls yet.")}</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{text("模型分布", "Model distribution")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          {tokens?.groups.length ? (
            tokens.groups.map((model) => (
              <div
                className="grid gap-1 border-b py-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:gap-4"
                key={model.key}
              >
                <strong>{model.key || text("未登记模型", "Unregistered model")}</strong>
                <span>{decimal(model.value ?? "0", 0)} Token</span>
                <span>{formatAiuMicros(aiuByModel.get(model.key) ?? "0", locale)}</span>
                <span>{costsByModel.get(model.key)?.join(" · ") ?? "-"}</span>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              {text("暂无模型用量。", "No model usage yet.")}
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{text("当前成员", "Current members")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          {members?.length ? (
            members.slice(0, 200).map((member) => (
              <div
                className="flex items-center justify-between border-b py-2 text-sm"
                key={member.id}
              >
                <span data-i18n-skip>{member.display_user || member.user_id}</span>
                <Badge variant={member.status === "blocked" ? "destructive" : "outline"}>
                  {member.status === "blocked" ? text("已停止", "Blocked") : text("正常", "Active")}
                </Badge>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              {text("还没有成员，请先刷新。", "No members yet. Refresh the group first.")}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

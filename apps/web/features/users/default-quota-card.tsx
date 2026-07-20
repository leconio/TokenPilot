"use client";

import { Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatAiuMicros } from "@/features/control-plane/quota/aiu-values";
import { useLocale } from "@/i18n/locale-provider";
import type { AiuQuotaPolicy } from "./types";

function periodLabel(period: string, text: (chinese: string, english: string) => string): string {
  if (period === "month") return text("每月", "monthly");
  if (period === "week") return text("每周", "weekly");
  if (period === "day") return text("每天", "daily");
  if (period === "fixed") return text("固定时间", "fixed dates");
  return text("长期", "lifetime");
}

export function DefaultQuotaCard({
  policy,
  onEdit,
}: Readonly<{ policy: AiuQuotaPolicy | null; onEdit: () => void }>) {
  const { locale, text } = useLocale();
  const summary =
    policy === null
      ? text(
          "尚未设置；可以单独为用户或用户组设置额度。",
          "Not set; you can still set an allowance for a user or group.",
        )
      : `${formatAiuMicros(policy.limit_aiu_micros, locale)} · ${periodLabel(policy.period, text)} · ${
          policy.hard_limit
            ? text("用完停止调用", "stop when used")
            : text("只提醒", "warning only")
        }`;
  return (
    <Card size="sm" className="bg-card/80">
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <strong>{text("默认 AIU 额度", "Default AIU allowance")}</strong>
          <p className="text-sm text-muted-foreground">{summary}</p>
        </div>
        <Button variant="outline" onClick={onEdit}>
          <Settings2 />
          {policy === null ? text("设置默认额度", "Set default") : text("修改", "Edit")}
        </Button>
      </CardContent>
    </Card>
  );
}

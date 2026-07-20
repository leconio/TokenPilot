"use client";

import { AlertTriangle, Inbox, RotateCw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export type PageStateKind = "loading" | "empty" | "error" | "partial" | "stale";

export function PageState({
  state,
  message,
  onRetry,
}: Readonly<{
  state: PageStateKind;
  message?: string | undefined;
  onRetry?: (() => void) | undefined;
}>) {
  if (state === "loading") {
    return (
      <div className="loading" role="status" aria-label="正在加载">
        <div className="grid w-[min(520px,80%)] gap-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton className="skeleton" key={index} style={{ width: `${100 - index * 6}%` }} />
          ))}
        </div>
      </div>
    );
  }
  if (state === "empty") {
    return (
      <div className="empty" role="status">
        <div>
          <Inbox aria-hidden="true" size={26} />
          <strong>暂无数据</strong>
          <span>{message ?? "完成首次配置后，数据会显示在这里。"}</span>
        </div>
      </div>
    );
  }
  const isError = state === "error";
  return (
    <Alert
      className={isError ? "border-destructive/40" : "border-amber-500/40"}
      variant={isError ? "destructive" : "default"}
    >
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>
        {isError ? "加载失败" : state === "stale" ? "数据已过期" : "部分数据不可用"}
      </AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span>{message ?? "正式数据仍可使用；请检查对应数据源后重试。"}</span>
        {onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RotateCw aria-hidden="true" />
            重试
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

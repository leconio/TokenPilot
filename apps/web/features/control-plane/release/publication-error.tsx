"use client";

import { CircleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useLocale } from "@/i18n/locale-provider";
import { ApiError } from "@/lib/api";

interface PublicationIssue {
  readonly code: string;
  readonly message: string;
  readonly object_name?: string;
}

const ChineseIssue: Readonly<Record<string, string>> = {
  NO_ENABLED_VIRTUAL_MODEL: "至少启用一个虚拟模型。",
  CONNECTION_CONFIGURATION_INVALID: "调用连接的设置不完整。",
  VIRTUAL_MODEL_HAS_NO_ROUTE: "没有可用的真实模型。",
  VIRTUAL_MODEL_DEFAULT_UNAVAILABLE: "首选真实模型当前不可用。",
  VIRTUAL_MODEL_TASK_MISMATCH: "包含用途不同的真实模型。",
  MODEL_CAPABILITIES_INVALID: "真实模型的能力设置不正确。",
  ROUTE_PRIORITY_DUPLICATE: "多个调用条件使用了相同顺序。",
  ROUTE_CONDITION_INVALID: "包含无法使用的调用条件。",
  USER_GROUP_SNAPSHOT_MISSING: "用户组还没有可用的成员结果。",
  ROUTE_TARGET_UNAVAILABLE: "调用条件指向了不可用的真实模型。",
};

function issues(error: Error): readonly PublicationIssue[] {
  if (!(error instanceof ApiError) || error.code !== "PUBLICATION_VALIDATION_FAILED") return [];
  const payload = error.payload;
  if (payload === null || typeof payload !== "object" || !("issues" in payload)) return [];
  const value = (payload as { readonly issues?: unknown }).issues;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.code !== "string" || typeof record.message !== "string") return [];
    return [
      {
        code: record.code,
        message: record.message,
        ...(typeof record.object_name === "string" ? { object_name: record.object_name } : {}),
      },
    ];
  });
}

export function PublicationError({ error }: Readonly<{ error: Error | null }>) {
  const { locale, text } = useLocale();
  if (error === null) return null;
  const found = issues(error);
  if (found.length === 0) {
    return <p className="text-sm text-destructive">{error.message}</p>;
  }
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>
        {text("发布前需要处理以下问题", "Resolve these issues before publishing")}
      </AlertTitle>
      <AlertDescription>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {found.map((issue, index) => (
            <li key={`${issue.code}:${issue.object_name ?? "unknown"}:${index}`}>
              {issue.object_name ? <strong data-i18n-skip>{issue.object_name}：</strong> : null}
              {locale === "zh-CN" ? (ChineseIssue[issue.code] ?? error.message) : issue.message}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

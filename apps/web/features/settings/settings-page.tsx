"use client";

import { useQuery } from "@tanstack/react-query";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeading } from "@/features/shared/components/page-heading";
import { PageState } from "@/features/shared/components/page-state";
import { PermissionBoundary } from "@/features/shared/components/permission-boundary";
import {
  datastoreUnavailableMessage,
  requiredDatastoreHealth,
} from "@/features/shared/required-datastores";
import { controlApi } from "@/lib/api";
import {
  applicationApiPath,
  useCurrentApplicationSlug,
} from "@/features/applications/use-current-application";
import { ApiKeysPanel } from "./api-keys-panel";
import { ApplicationManagementPanel } from "./application-management-panel";
import type { SettingsResponse } from "./types";

type PlainRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as PlainRecord)
    : {};
}

function text(value: unknown, fallback = "-"): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function privacyState(value: unknown): string {
  return value === true ? "保存" : "不保存";
}

export function SettingsPage() {
  const applicationSlug = useCurrentApplicationSlug();
  const settingsPath = applicationApiPath(applicationSlug, "/settings");
  const settings = useQuery({
    queryKey: ["application-settings", applicationSlug],
    queryFn: () => controlApi<SettingsResponse & PlainRecord>(settingsPath!),
    enabled: settingsPath !== null,
  });
  const readiness = useQuery({
    queryKey: ["health-ready"],
    queryFn: () => controlApi<PlainRecord>("/health/ready"),
    retry: false,
    refetchInterval: 30_000,
  });

  if (settings.isPending) {
    return (
      <main className="page">
        <PageHeading title="设置" description="正在读取当前设置。" />
        <PageState state="loading" />
      </main>
    );
  }
  if (settings.isError) {
    return (
      <main className="page">
        <PageHeading title="设置" description="当前设置暂时不可用。" />
        <PageState
          state="error"
          message={settings.error.message}
          onRetry={() => void settings.refetch()}
        />
      </main>
    );
  }

  const privacy = record(settings.data.privacy);
  const stores = requiredDatastoreHealth(readiness.data);
  const storageUnavailable = readiness.isError || (readiness.isSuccess && !stores.ready);
  return (
    <main className="page">
      <PageHeading
        title="设置"
        description="查看基本信息、管理访问密钥和隐私保护。日常使用通常不需要修改这里。"
      />
      <PermissionBoundary permission="admin:read">
        {storageUnavailable ? (
          <Alert className="mb-4" variant="destructive">
            <AlertDescription>{datastoreUnavailableMessage}</AlertDescription>
          </Alert>
        ) : null}
        <Tabs defaultValue="general">
          <TabsList className="flex h-auto flex-wrap">
            <TabsTrigger value="general">基本信息</TabsTrigger>
            <TabsTrigger value="applications">应用管理</TabsTrigger>
            <TabsTrigger value="keys">访问密钥</TabsTrigger>
            <TabsTrigger value="privacy">隐私保护</TabsTrigger>
            <TabsTrigger value="advanced">高级诊断</TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="grid max-w-2xl gap-4 pt-4">
            <Card>
              <CardHeader>
                <CardTitle>服务信息</CardTitle>
                <CardDescription>统计口径在整个系统中保持一致。</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="definition">
                  <div>
                    <dt>服务名称</dt>
                    <dd>{text(settings.data.app_name, "TokenPilot")}</dd>
                  </div>
                  <div>
                    <dt>系统状态</dt>
                    <dd>{readiness.isPending ? "正在检查" : stores.ready ? "可用" : "不可用"}</dd>
                  </div>
                  <div>
                    <dt>默认时区</dt>
                    <dd>{settings.data.timezone}</dd>
                  </div>
                  <div>
                    <dt>模型花费币种</dt>
                    <dd>{settings.data.base_currency}</dd>
                  </div>
                  <div>
                    <dt>明细保留</dt>
                    <dd>
                      {settings.data.raw_event_retention_days ?? settings.data.retention_days ?? 30}{" "}
                      天
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="applications" className="pt-4">
            <ApplicationManagementPanel />
          </TabsContent>

          <TabsContent value="keys" className="pt-4">
            <ApiKeysPanel />
          </TabsContent>

          <TabsContent value="privacy" className="grid gap-4 pt-4">
            <Alert>
              <AlertDescription>
                系统只保存统计所需的数据，不保存提示词和模型回答正文。
              </AlertDescription>
            </Alert>
            <Card>
              <CardHeader>
                <CardTitle>内容保存范围</CardTitle>
                <CardDescription>这些限制由服务端统一执行，网页不能绕过。</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="definition">
                  <div>
                    <dt>提示词正文</dt>
                    <dd>{privacyState(privacy.store_prompt_content ?? privacy.prompt)}</dd>
                  </div>
                  <div>
                    <dt>模型回答正文</dt>
                    <dd>{privacyState(privacy.store_response_content ?? privacy.response)}</dd>
                  </div>
                  <div>
                    <dt>用量明细</dt>
                    <dd>
                      保留{" "}
                      {settings.data.raw_event_retention_days ?? settings.data.retention_days ?? 30}{" "}
                      天
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="advanced" className="grid gap-4 pt-4">
            <Card>
              <CardHeader>
                <CardTitle>运行诊断</CardTitle>
                <CardDescription>仅在排查问题时生成，不包含密钥或模型内容。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                <Button
                  className="w-fit"
                  disabled={readiness.isFetching}
                  onClick={() => void readiness.refetch()}
                >
                  {readiness.isFetching ? "正在检查…" : "检查当前状态"}
                </Button>
                {readiness.isError ? (
                  <PageState state="error" message={datastoreUnavailableMessage} />
                ) : readiness.data ? (
                  <Collapsible>
                    <CollapsibleTrigger asChild>
                      <Button size="sm" variant="outline">
                        查看诊断详情
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <pre className="code mt-3">{JSON.stringify(readiness.data, null, 2)}</pre>
                    </CollapsibleContent>
                  </Collapsible>
                ) : null}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </PermissionBoundary>
    </main>
  );
}

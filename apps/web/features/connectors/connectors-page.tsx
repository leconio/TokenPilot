"use client";

import { useState } from "react";
import {
  applicationApiPath,
  useCurrentApplicationSlug,
} from "@/features/applications/use-current-application";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { normalizePage } from "@/features/control-plane/api/client";
import { useControlQuery } from "@/features/control-plane/api/hooks";
import type { ReportEnvelope } from "@/features/control-plane/api/types";
import { DataTable, type DataColumn } from "@/features/shared/components/data-table";
import { PageHeading } from "@/features/shared/components/page-heading";
import { PageState } from "@/features/shared/components/page-state";
import { PermissionBoundary } from "@/features/shared/components/permission-boundary";
import {
  datastoreUnavailableMessage,
  requiredDatastoreHealth,
} from "@/features/shared/required-datastores";
import { StatusBadge } from "@/features/shared/components/status-badge";
import { useInstanceTimezone } from "@/components/instance-timezone";
import { useLocale } from "@/i18n/locale-provider";
import { fullDateTime } from "@/lib/time";

interface ConnectorRecord {
  readonly id: string;
  readonly instance_id: string;
  readonly name: string;
  readonly type: string;
  readonly version: string;
  readonly status: string;
  readonly last_heartbeat_at: string;
  readonly buffer_depth: number;
  readonly oldest_event_age_seconds: string | null;
  readonly metadata?: {
    readonly last_successful_upload_at?: string | null;
    readonly capabilities?: {
      readonly usage_schema?: string;
      readonly application_users?: boolean;
      readonly privacy_mode?: string;
      readonly durable_batch_upload?: boolean;
    };
  };
}

type PlainRecord = Readonly<Record<string, unknown>>;

const healthLabels: ReadonlyArray<readonly [string, string]> = [
  ["connector", "数据接收"],
  ["postgres", "用量存储"],
  ["clickhouse", "分析数据"],
  ["settlement", "AIU 与花费计算"],
  ["reconciliation", "数据校对"],
];

function protectedDetails(value: unknown): string {
  return JSON.stringify(
    value,
    (key, item) => (/key|secret|token/iu.test(key) ? "[已隐藏]" : item),
    2,
  );
}

export function ConnectorsPage() {
  const { locale } = useLocale();
  const applicationSlug = useCurrentApplicationSlug();
  const timezone = useInstanceTimezone();
  const connectors = useControlQuery<unknown>(
    ["application-connectors", applicationSlug],
    applicationApiPath(applicationSlug, "/connectors"),
    undefined,
    { refetchInterval: 30_000 },
  );
  const pipeline = useControlQuery<ReportEnvelope<PlainRecord>>(
    ["pipeline-health", applicationSlug],
    applicationApiPath(applicationSlug, "/reports/pipeline-health"),
    { timezone: "UTC" },
  );
  const readiness = useControlQuery<PlainRecord>(
    ["required-datastores"],
    "/health/ready",
    undefined,
    { retry: false, refetchInterval: 30_000 },
  );
  const rows = normalizePage<ConnectorRecord>(connectors.data, ["connectors"]).items;
  const [selected, setSelected] = useState<ConnectorRecord | null>(null);
  const [checkState, setCheckState] = useState<"idle" | "checking" | "success" | "error">("idle");

  async function checkConnection() {
    setCheckState("checking");
    const [connectorResult, pipelineResult, readinessResult] = await Promise.all([
      connectors.refetch(),
      pipeline.refetch(),
      readiness.refetch(),
    ]);
    const stores = requiredDatastoreHealth(readinessResult.data);
    setCheckState(
      connectorResult.isError || pipelineResult.isError || readinessResult.isError || !stores.ready
        ? "error"
        : "success",
    );
  }

  const columns: DataColumn<ConnectorRecord>[] = [
    { key: "name", label: "名称", cell: (row) => <strong>{row.name}</strong> },
    { key: "status", label: "状态", cell: (row) => <StatusBadge value={row.status} /> },
    {
      key: "last_heartbeat_at",
      label: "最近连接",
      cell: (row) => fullDateTime(row.last_heartbeat_at, timezone, locale),
    },
  ];

  const health = pipeline.data?.data;
  const stores = requiredDatastoreHealth(readiness.data);
  const storageUnavailable = readiness.isError || (readiness.isSuccess && !stores.ready);

  return (
    <main className="page">
      <PageHeading
        title="服务连接"
        description="查看模型调用数据是否正常上传，遇到问题时可检查连接。"
        actions={
          <>
            <Button variant="outline" onClick={() => void connectors.refetch()}>
              刷新
            </Button>
            <Button disabled={checkState === "checking"} onClick={() => void checkConnection()}>
              {checkState === "checking" ? "正在检查…" : "检查连接"}
            </Button>
          </>
        }
      />
      <PermissionBoundary permission="admin:read">
        <div className="grid gap-5">
          {checkState === "error" ? (
            <Alert variant="destructive">
              <AlertDescription>{datastoreUnavailableMessage}</AlertDescription>
            </Alert>
          ) : checkState === "success" ? (
            <Alert>
              <AlertDescription>状态已刷新，请查看下面的检查结果。</AlertDescription>
            </Alert>
          ) : null}

          {checkState !== "error" && storageUnavailable ? (
            <Alert variant="destructive">
              <AlertDescription>{datastoreUnavailableMessage}</AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>数据处理状态</CardTitle>
              <CardDescription>页面每 30 秒自动更新。</CardDescription>
            </CardHeader>
            <CardContent>
              {pipeline.isError ? (
                <PageState state="partial" message="暂时无法读取处理状态，请稍后重试。" />
              ) : pipeline.isPending ? (
                <PageState state="loading" />
              ) : (
                <dl className="definition">
                  {healthLabels.map(([key, label]) => (
                    <div key={key}>
                      <dt>{label}</dt>
                      <dd>
                        <StatusBadge
                          value={
                            key === "postgres"
                              ? stores.postgres
                              : key === "clickhouse"
                                ? stores.clickhouse
                                : (health?.[key] ?? "unknown")
                          }
                        />
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </CardContent>
          </Card>

          {connectors.isPending ? (
            <PageState state="loading" />
          ) : connectors.isError ? (
            <PageState
              state="error"
              message={connectors.error.message}
              onRetry={() => void connectors.refetch()}
            />
          ) : (
            <DataTable
              columns={columns}
              rows={[...rows]}
              showColumnSelector={false}
              showExport={false}
              onRowClick={setSelected}
              emptyMessage="服务接入并首次上报后会显示在这里。"
            />
          )}

          <Collapsible className="rounded-lg border p-3">
            <CollapsibleTrigger asChild>
              <Button size="sm" variant="ghost">
                接入指引
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Card className="mt-4">
                <CardHeader>
                  <CardTitle>接入 LiteLLM</CardTitle>
                  <CardDescription>
                    以下内容供部署人员使用，访问密钥不会显示在网页中。
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3">
                  <pre className="code">uv pip install -e connectors/litellm</pre>
                  <pre className="code">{`litellm_settings:\n  turn_off_message_logging: true\n  callbacks:\n    - ai_control_callback.proxy_handler_instance`}</pre>
                </CardContent>
              </Card>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </PermissionBoundary>

      {selected ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{selected.name}</DialogTitle>
              <DialogDescription>服务连接详情</DialogDescription>
            </DialogHeader>
            <dl className="definition">
              <div>
                <dt>状态</dt>
                <dd>
                  <StatusBadge value={selected.status} />
                </dd>
              </div>
              <div>
                <dt>版本</dt>
                <dd>{selected.version}</dd>
              </div>
              <div>
                <dt>最近连接</dt>
                <dd>{fullDateTime(selected.last_heartbeat_at, timezone, locale)}</dd>
              </div>
              <div>
                <dt>待上传</dt>
                <dd>{selected.buffer_depth} 条</dd>
              </div>
            </dl>
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button size="sm" variant="outline">
                  查看高级信息
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="code mt-3">{protectedDetails(selected)}</pre>
              </CollapsibleContent>
            </Collapsible>
          </DialogContent>
        </Dialog>
      ) : null}
    </main>
  );
}

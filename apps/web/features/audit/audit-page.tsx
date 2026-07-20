"use client";

import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import { useInstanceTimezone } from "@/components/instance-timezone";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  applicationApiPath,
  useCurrentApplicationSlug,
} from "@/features/applications/use-current-application";
import { DataTable, type DataColumn } from "@/features/shared/components/data-table";
import { DetailSheet } from "@/features/shared/components/detail-sheet";
import { PageHeading } from "@/features/shared/components/page-heading";
import { PageState } from "@/features/shared/components/page-state";
import { useLocale } from "@/i18n/locale-provider";
import { controlApi } from "@/lib/api";
import { fullDateTime } from "@/lib/time";

interface AuditEntry {
  readonly id: string;
  readonly actor_id: string | null;
  readonly action: string;
  readonly object_type: string;
  readonly object_id: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
  readonly created_at: string;
}

type Category = "all" | "models" | "users" | "access" | "other";

const categories: readonly { value: Category; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "models", label: "模型与分流" },
  { value: "users", label: "用户与 AIU" },
  { value: "access", label: "应用与访问" },
  { value: "other", label: "其他" },
];

function categoryOf(entry: AuditEntry): Exclude<Category, "all"> {
  if (/^(model|virtual_model|runtime_configuration)\./u.test(entry.action)) return "models";
  if (/^(user|user_group|application_user)\./u.test(entry.action)) return "users";
  if (/^(application|service_api_key)\./u.test(entry.action)) return "access";
  return "other";
}

const actionLabels: Readonly<Record<string, string>> = {
  "application.create": "创建应用",
  "application.update": "更新应用",
  "model.create": "添加模型",
  "model.update": "更新模型",
  "model.cost.publish": "更新模型成本",
  "model.aiu.publish": "更新 AIU 换算率",
  "virtual_model.create": "创建虚拟模型",
  "virtual_model.update": "更新虚拟模型",
  "runtime_configuration.publish": "发布分流配置",
  "user.create": "添加用户",
  "user.update": "更新用户",
  "user.access.update": "更新用户调用状态",
  "user.quota.update": "更新用户额度",
  "user.quota.reset": "重置用户额度",
  "service_api_key.create": "创建访问密钥",
  "service_api_key.revoke": "停用访问密钥",
};

function actionLabel(action: string): string {
  return actionLabels[action] ?? "更新配置";
}

function objectLabel(type: string): string {
  if (type === "application") return "应用";
  if (type === "model") return "模型";
  if (type === "virtual_model") return "虚拟模型";
  if (type === "application_user") return "用户";
  if (type.includes("user_group")) return "用户组";
  if (type.includes("service_api_key")) return "访问密钥";
  if (type.includes("runtime_configuration")) return "分流配置";
  return "配置";
}

export function AuditPage() {
  const { locale } = useLocale();
  const applicationSlug = useCurrentApplicationSlug();
  const timezone = useInstanceTimezone();
  const [category, setCategory] = useState<Category>("all");
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const path = applicationApiPath(applicationSlug, "/audit");
  const audit = useQuery({
    queryKey: ["application-audit", applicationSlug],
    queryFn: () => controlApi<{ entries: readonly AuditEntry[] }>(`${path}?limit=200`),
    enabled: path !== null,
  });
  const entries = audit.data?.entries ?? [];
  const filtered = useMemo(
    () =>
      category === "all" ? entries : entries.filter((entry) => categoryOf(entry) === category),
    [category, entries],
  );
  const columns: DataColumn<AuditEntry>[] = [
    {
      key: "time",
      label: "时间",
      cell: (row) => fullDateTime(row.created_at, timezone, locale),
    },
    { key: "action", label: "操作", cell: (row) => <strong>{actionLabel(row.action)}</strong> },
    { key: "object", label: "对象", cell: (row) => objectLabel(row.object_type) },
    {
      key: "actor",
      label: "操作者",
      cell: (row) => <span data-i18n-skip>{row.actor_id ?? "系统"}</span>,
    },
    {
      key: "reason",
      label: "说明",
      cell: (row) => <span data-i18n-skip>{row.reason ?? "系统自动执行"}</span>,
    },
  ];
  return (
    <main className="page">
      <PageHeading
        title="操作记录"
        description="只显示当前应用中的配置和管理操作。"
        actions={
          <Button variant="outline" onClick={() => void audit.refetch()}>
            <RefreshCw />
            刷新
          </Button>
        }
      />
      <Tabs value={category} onValueChange={(value) => setCategory(value as Category)}>
        <TabsList aria-label="操作分类" className="h-auto flex-wrap justify-start">
          {categories.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {audit.isPending ? <PageState state="loading" /> : null}
      {audit.isError ? (
        <PageState state="error" message={audit.error.message} onRetry={() => audit.refetch()} />
      ) : null}
      {audit.isSuccess ? (
        <DataTable
          rows={[...filtered]}
          columns={columns}
          onRowClick={setSelected}
          emptyMessage="还没有操作记录。"
        />
      ) : null}
      {selected ? (
        <DetailSheet title={actionLabel(selected.action)} onClose={() => setSelected(null)}>
          <dl className="definition">
            <div>
              <dt>时间</dt>
              <dd>{fullDateTime(selected.created_at, timezone, locale)}</dd>
            </div>
            <div>
              <dt>对象</dt>
              <dd>{objectLabel(selected.object_type)}</dd>
            </div>
            <div>
              <dt>操作者</dt>
              <dd data-i18n-skip>{selected.actor_id ?? "系统"}</dd>
            </div>
            <div>
              <dt>说明</dt>
              <dd data-i18n-skip>{selected.reason ?? "系统自动执行"}</dd>
            </div>
          </dl>
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium">查看详细变化</summary>
            <div className="grid-even mt-3">
              <pre className="code">{JSON.stringify(selected.before, null, 2)}</pre>
              <pre className="code">{JSON.stringify(selected.after, null, 2)}</pre>
            </div>
          </details>
        </DetailSheet>
      ) : null}
    </main>
  );
}

"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Rocket, RotateCcw, Settings2 } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Button } from "@/components/ui/button";
import { DataTable, type DataColumn } from "@/features/shared/components/data-table";
import { PageHeading } from "@/features/shared/components/page-heading";
import { PageState } from "@/features/shared/components/page-state";
import { PermissionBoundary } from "@/features/shared/components/permission-boundary";
import { StatusBadge } from "@/features/shared/components/status-badge";
import { controlApi } from "@/lib/api";
import { PublicationError } from "./publication-error";

interface ConfigurationVersion {
  readonly id: string;
  readonly version: number;
  readonly status: "DRAFT" | "PUBLISHED" | "RETIRED";
  readonly effective_state: "pending" | "received" | "applied" | "rejected" | "retired";
  readonly published_at: string | null;
  readonly connectors: readonly {
    readonly instance_id: string;
    readonly state: "pending" | "received" | "applied" | "rejected";
    readonly error: { readonly message: string } | null;
  }[];
}

interface ConfigurationList {
  readonly versions: readonly ConfigurationVersion[];
}

export function ReleaseCenterPage() {
  const pathname = usePathname();
  const slug = /^\/apps\/([^/]+)/u.exec(pathname)?.[1] ?? "";
  const path = `/applications/${slug}/runtime-configurations`;
  const client = useQueryClient();
  const configurations = useQuery({
    queryKey: ["runtime-configurations", slug],
    queryFn: () => controlApi<ConfigurationList>(path),
    enabled: slug.length > 0,
    refetchInterval: 5_000,
  });
  const publish = useMutation({
    mutationFn: () =>
      controlApi<{ readonly version: number }>(`${path}/publish`, { method: "POST" }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["runtime-configurations", slug] });
      await client.invalidateQueries({ queryKey: ["virtual-models", slug] });
    },
  });
  const restore = useMutation({
    mutationFn: (version: number) =>
      controlApi<{ readonly version: number; readonly restored_from_version: number }>(
        `${path}/${version}/restore`,
        { method: "POST" },
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["runtime-configurations", slug] });
      await client.invalidateQueries({ queryKey: ["virtual-models", slug] });
    },
  });
  const columns: DataColumn<ConfigurationVersion>[] = [
    { key: "version", label: "配置", cell: (record) => `#${record.version}` },
    {
      key: "status",
      label: "状态",
      cell: (record) => (
        <StatusBadge value={record.status === "PUBLISHED" ? "active" : "retired"} />
      ),
    },
    {
      key: "effective",
      label: "生效状态",
      cell: (record) => {
        const error = record.connectors.find((connector) => connector.error !== null)?.error;
        return (
          <div className="grid gap-1">
            <span>
              <StatusBadge value={record.effective_state} />
            </span>
            {error ? <span className="text-xs text-destructive">{error.message}</span> : null}
          </div>
        );
      },
    },
    {
      key: "published",
      label: "发布时间",
      cell: (record) =>
        record.published_at === null ? "-" : new Date(record.published_at).toLocaleString(),
    },
    {
      key: "actions",
      label: "操作",
      cell: (record) => (
        <PermissionBoundary permission="configuration:write" hideWhenDenied>
          <Button
            size="sm"
            variant="outline"
            disabled={restore.isPending}
            onClick={() => restore.mutate(record.version)}
          >
            <RotateCcw />
            {record.status === "PUBLISHED" ? "重新发布" : "恢复此版本"}
          </Button>
        </PermissionBoundary>
      ),
    },
  ];
  return (
    <PermissionBoundary permission="configuration:read">
      <main className="page">
        <PageHeading
          title="配置发布"
          description="检查并发布当前应用全部虚拟模型的默认模型、时段和失败顺序。"
          actions={
            <>
              <Button asChild variant="outline">
                <Link href={`/apps/${slug}/virtual-models`}>
                  <Settings2 />
                  维护虚拟模型
                </Link>
              </Button>
              <PermissionBoundary permission="configuration:write" hideWhenDenied>
                <Button disabled={publish.isPending} onClick={() => publish.mutate()}>
                  <Rocket />
                  {publish.isPending ? "发布中…" : "发布当前配置"}
                </Button>
              </PermissionBoundary>
            </>
          }
        />
        {publish.data ? (
          <p className="text-sm text-muted-foreground">
            配置 #{publish.data.version} 已发布，等待服务确认。
          </p>
        ) : null}
        <PublicationError error={publish.error} />
        {restore.data ? (
          <p className="text-sm text-muted-foreground">
            已从配置 #{restore.data.restored_from_version} 创建新配置 #{restore.data.version}
            ，等待服务确认。
          </p>
        ) : null}
        {restore.error ? <p className="text-sm text-destructive">{restore.error.message}</p> : null}
        {configurations.isPending ? (
          <PageState state="loading" />
        ) : configurations.error ? (
          <PageState
            state="error"
            message={configurations.error.message}
            onRetry={() => configurations.refetch()}
          />
        ) : (
          <DataTable
            columns={columns}
            emptyMessage="还没有发布配置。"
            rows={[...(configurations.data?.versions ?? [])]}
          />
        )}
      </main>
    </PermissionBoundary>
  );
}

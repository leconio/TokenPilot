"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  applicationApiPath,
  useCurrentApplicationSlug,
} from "@/features/applications/use-current-application";
import { normalizePage } from "@/features/control-plane/api/client";
import { DataTable, type DataColumn } from "@/features/shared/components/data-table";
import { PageHeading } from "@/features/shared/components/page-heading";
import { PageState } from "@/features/shared/components/page-state";
import { StatusBadge } from "@/features/shared/components/status-badge";
import { useInstanceTimezone } from "@/components/instance-timezone";
import { useLocale } from "@/i18n/locale-provider";
import { controlApi } from "@/lib/api";
import { fullDateTime } from "@/lib/time";
import { ConnectionCreateDialog, type CreateConnectionInput } from "./connection-create-dialog";
import {
  connectionDriverLabels,
  type CallConnection,
  type ConnectorOption,
} from "./connection-types";
import { ModelSectionNav } from "./model-section-nav";

export function ConnectionsPage() {
  const { locale, text } = useLocale();
  const timezone = useInstanceTimezone();
  const applicationSlug = useCurrentApplicationSlug();
  const base = applicationApiPath(applicationSlug, "") ?? "";
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<CallConnection | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);

  const connections = useQuery({
    queryKey: ["call-connections", applicationSlug],
    queryFn: () => controlApi<{ connections: readonly CallConnection[] }>(`${base}/connections`),
    enabled: applicationSlug.length > 0,
    refetchInterval: 30_000,
  });
  const connectors = useQuery({
    queryKey: ["application-connectors", applicationSlug],
    queryFn: () => controlApi<unknown>(`${base}/connectors`),
    enabled: applicationSlug.length > 0,
  });
  const connectorOptions = normalizePage<ConnectorOption>(connectors.data, ["connectors"]).items;

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["call-connections", applicationSlug] });
  }

  const create = useMutation({
    mutationFn: (input: CreateConnectionInput) =>
      controlApi<CallConnection>(`${base}/connections`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: async () => {
      setCreating(false);
      await refresh();
    },
  });
  const update = useMutation({
    mutationFn: (connection: CallConnection) =>
      controlApi<CallConnection>(`${base}/connections/${connection.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !connection.enabled }),
      }),
    onSuccess: async (connection) => {
      setSelected(connection);
      await refresh();
    },
  });
  const check = useMutation({
    mutationFn: (connection: CallConnection) =>
      controlApi<{ valid: boolean; message: string }>(
        `${base}/connections/${connection.id}/check`,
        { method: "POST" },
      ),
    onSuccess: (result) =>
      setCheckMessage(
        result.valid
          ? text("调用连接设置可用。", "The connection is ready to use.")
          : text(
              "请先绑定已上报的 LiteLLM，再重新检查。",
              "Bind a reported LiteLLM instance, then check again.",
            ),
      ),
  });
  const remove = useMutation({
    mutationFn: (connection: CallConnection) =>
      controlApi<{ deleted: true }>(`${base}/connections/${connection.id}`, {
        method: "DELETE",
      }),
    onSuccess: async () => {
      setConfirmDelete(false);
      setSelected(null);
      await refresh();
    },
  });

  const columns: DataColumn<CallConnection>[] = [
    { key: "name", label: "名称", cell: (row) => <strong data-i18n-skip>{row.name}</strong> },
    { key: "driver", label: "类型", cell: (row) => connectionDriverLabels[row.driver] },
    { key: "status", label: "状态", cell: (row) => <StatusBadge value={row.status} /> },
    { key: "model_count", label: "真实模型", cell: (row) => `${row.model_count} 个` },
    {
      key: "last_seen_at",
      label: "最近连接",
      cell: (row) =>
        row.last_seen_at === null ? "尚未连接" : fullDateTime(row.last_seen_at, timezone, locale),
    },
  ];
  return (
    <main className="page">
      <PageHeading
        title="模型"
        description="配置应用可调用的服务、真实模型和自动分流。"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus />
            添加调用连接
          </Button>
        }
      />
      <ModelSectionNav />
      {connections.isPending ? (
        <PageState state="loading" />
      ) : connections.error ? (
        <PageState
          state="error"
          message={connections.error.message}
          onRetry={() => connections.refetch()}
        />
      ) : (
        <DataTable
          columns={columns}
          emptyMessage="先添加调用连接，再录入真实模型。"
          rows={[...(connections.data?.connections ?? [])]}
          onRowClick={(connection) => {
            setCheckMessage(null);
            setSelected(connection);
          }}
        />
      )}

      <ConnectionCreateDialog
        connectorOptions={connectorOptions}
        error={create.error}
        isPending={create.isPending}
        open={creating}
        onOpenChange={setCreating}
        onSubmit={(input) => create.mutate(input)}
      />

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle data-i18n-skip>{selected?.name}</DialogTitle>
            <DialogDescription>调用连接详情</DialogDescription>
          </DialogHeader>
          {selected ? (
            <div className="grid gap-4">
              <dl className="definition">
                <div>
                  <dt>类型</dt>
                  <dd>{connectionDriverLabels[selected.driver]}</dd>
                </div>
                <div>
                  <dt>状态</dt>
                  <dd>
                    <StatusBadge value={selected.status} />
                  </dd>
                </div>
                <div>
                  <dt>服务地址</dt>
                  <dd className="break-all" data-i18n-skip>
                    {selected.base_url ?? "使用默认地址"}
                  </dd>
                </div>
                <div>
                  <dt>本地密钥名称</dt>
                  <dd data-i18n-skip>{selected.credential_ref ?? "无需密钥"}</dd>
                </div>
                <div>
                  <dt>真实模型</dt>
                  <dd>{selected.model_count} 个</dd>
                </div>
              </dl>
              {checkMessage ? (
                <Alert>
                  <CheckCircle2 />
                  <AlertDescription>{checkMessage}</AlertDescription>
                </Alert>
              ) : null}
              {(check.error ?? update.error ?? remove.error) ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    {(check.error ?? update.error ?? remove.error)?.message}
                  </AlertDescription>
                </Alert>
              ) : null}
              <div className="flex flex-wrap justify-between gap-3">
                <Button
                  aria-label="删除调用连接"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 />
                  删除
                </Button>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => check.mutate(selected)}>
                    {check.isPending ? "正在检查…" : "检查配置"}
                  </Button>
                  <Button size="sm" onClick={() => update.mutate(selected)}>
                    {selected.enabled ? "停用" : "启用"}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除调用连接？</DialogTitle>
            <DialogDescription>
              如果仍有真实模型使用此连接，请先将这些模型移到其他连接。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button
              disabled={selected === null || remove.isPending}
              variant="destructive"
              onClick={() => selected && remove.mutate(selected)}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

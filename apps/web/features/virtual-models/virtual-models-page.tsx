"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Rocket } from "lucide-react";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type DataColumn } from "@/features/shared/components/data-table";
import { PageHeading } from "@/features/shared/components/page-heading";
import { PageState } from "@/features/shared/components/page-state";
import { StatusBadge } from "@/features/shared/components/status-badge";
import { useLocale } from "@/i18n/locale-provider";
import { controlApi } from "@/lib/api";
import { VirtualModelStrategyDialog } from "./virtual-model-strategy-dialog";
import type { ModelItem, VirtualModelItem } from "./types";

function TargetCount({ count }: Readonly<{ count: number }>) {
  const { text } = useLocale();
  return `${count} ${text("个", "models")}`;
}

const columns: DataColumn<VirtualModelItem>[] = [
  {
    key: "name",
    label: "虚拟模型",
    cell: (model) => (
      <div>
        <strong data-i18n-skip>{model.display_name}</strong>
        <div className="text-xs text-muted-foreground" data-i18n-skip>
          {model.name}
        </div>
      </div>
    ),
  },
  {
    key: "default",
    label: "默认模型",
    cell: (model) =>
      model.default_model === null ? (
        "未设置"
      ) : (
        <span data-i18n-skip>{model.default_model.name}</span>
      ),
  },
  {
    key: "routes",
    label: "候选模型",
    cell: (model) => <TargetCount count={model.targets.length} />,
  },
  {
    key: "status",
    label: "状态",
    cell: (model) => <StatusBadge value={model.enabled ? "enabled" : "disabled"} />,
  },
];

export function VirtualModelsPage() {
  const pathname = usePathname();
  const slug = /^\/apps\/([^/]+)/u.exec(pathname)?.[1] ?? "";
  const base = `/applications/${slug}`;
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [selected, setSelected] = useState<VirtualModelItem | null>(null);
  const models = useQuery({
    queryKey: ["models", slug],
    queryFn: () => controlApi<{ models: readonly ModelItem[] }>(`${base}/models`),
    enabled: slug.length > 0,
  });
  const virtualModels = useQuery({
    queryKey: ["virtual-models", slug],
    queryFn: () =>
      controlApi<{ virtual_models: readonly VirtualModelItem[] }>(`${base}/virtual-models`),
    enabled: slug.length > 0,
  });
  async function refresh() {
    await client.invalidateQueries({ queryKey: ["virtual-models", slug] });
    setSelected(null);
  }
  async function changed(value: VirtualModelItem) {
    setSelected(value);
    await client.invalidateQueries({ queryKey: ["virtual-models", slug] });
  }
  const create = useMutation({
    mutationFn: () =>
      controlApi<VirtualModelItem>(`${base}/virtual-models`, {
        method: "POST",
        body: JSON.stringify({ name, display_name: displayName || name }),
      }),
    onSuccess: async () => {
      setCreating(false);
      setName("");
      setDisplayName("");
      await refresh();
    },
  });
  const publish = useMutation({
    mutationFn: () =>
      controlApi<{ readonly version: number }>(`${base}/runtime-configurations/publish`, {
        method: "POST",
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["virtual-models", slug] });
      await client.invalidateQueries({ queryKey: ["runtime-configurations", slug] });
    },
  });
  const loading = models.isPending || virtualModels.isPending;
  const error = models.error ?? virtualModels.error;

  return (
    <main className="page">
      <PageHeading
        title="虚拟模型"
        description="为业务提供稳定名称，并选择实际调用的模型和备用顺序。"
        actions={
          <>
            <Button variant="outline" disabled={publish.isPending} onClick={() => publish.mutate()}>
              <Rocket />
              {publish.isPending ? "发布中…" : "发布配置"}
            </Button>
            <Button onClick={() => setCreating(true)}>
              <Plus />
              添加虚拟模型
            </Button>
          </>
        }
      />
      {loading ? (
        <PageState state="loading" />
      ) : error ? (
        <PageState state="error" message={error.message} onRetry={() => virtualModels.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          emptyMessage="先添加一个虚拟模型。"
          rows={[...(virtualModels.data?.virtual_models ?? [])]}
          onRowClick={setSelected}
        />
      )}
      {publish.data ? (
        <p className="text-sm text-muted-foreground">配置 {publish.data.version} 已发布。</p>
      ) : null}
      {publish.error ? <p className="text-sm text-destructive">{publish.error.message}</p> : null}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加虚拟模型</DialogTitle>
            <DialogDescription>填写调用名称即可，创建后再选择实际模型。</DialogDescription>
          </DialogHeader>
          <div className="form-grid">
            <div className="field">
              <Label htmlFor="virtual-name">调用名称</Label>
              <Input
                id="virtual-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="field">
              <Label htmlFor="virtual-display">显示名称（可选）</Label>
              <Input
                id="virtual-display"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter showCloseButton>
            <Button
              disabled={name.length === 0 || create.isPending}
              onClick={() => create.mutate()}
            >
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <VirtualModelStrategyDialog
        model={selected}
        models={models.data?.models ?? []}
        path={`${base}/virtual-models`}
        onClose={() => setSelected(null)}
        onChanged={(value) => void changed(value)}
      />
    </main>
  );
}

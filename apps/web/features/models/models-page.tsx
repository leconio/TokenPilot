"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
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
import { controlApi } from "@/lib/api";

interface ModelDefinition {
  readonly id: string;
  readonly name: string;
  readonly litellm_tag: string;
  readonly provider: string | null;
  readonly enabled: boolean;
}

interface ModelList {
  readonly models: readonly ModelDefinition[];
}

const columns: DataColumn<ModelDefinition>[] = [
  {
    key: "name",
    label: "模型",
    cell: (model) => (
      <div>
        <strong data-i18n-skip>{model.name}</strong>
        <div className="text-xs text-muted-foreground">{model.litellm_tag}</div>
      </div>
    ),
  },
  { key: "provider", label: "服务商", cell: (model) => model.provider ?? "自动识别" },
  {
    key: "status",
    label: "状态",
    cell: (model) => <StatusBadge value={model.enabled ? "enabled" : "disabled"} />,
  },
];

export function ModelsPage() {
  const pathname = usePathname();
  const router = useRouter();
  const applicationSlug = /^\/apps\/([^/]+)/u.exec(pathname)?.[1] ?? "";
  const path = `/applications/${applicationSlug}/models`;
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const models = useQuery({
    queryKey: ["models", applicationSlug],
    queryFn: () => controlApi<ModelList>(path),
    enabled: applicationSlug.length > 0,
  });
  const create = useMutation({
    mutationFn: () =>
      controlApi<ModelDefinition>(path, {
        method: "POST",
        body: JSON.stringify({ name, litellm_tag: tag }),
      }),
    onSuccess: async () => {
      setCreating(false);
      setName("");
      setTag("");
      await client.invalidateQueries({ queryKey: ["models", applicationSlug] });
    },
  });

  return (
    <main className="page">
      <PageHeading
        title="模型"
        description="录入 LiteLLM 中实际使用的模型名称，并在详情中配置花费和 AIU。"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus />
            添加模型
          </Button>
        }
      />
      {models.isPending ? (
        <PageState state="loading" />
      ) : models.error ? (
        <PageState state="error" message={models.error.message} onRetry={() => models.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          emptyMessage="先添加一个模型。"
          rows={[...(models.data?.models ?? [])]}
          onRowClick={(model) => router.push(`/apps/${applicationSlug}/models/${model.id}`)}
        />
      )}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加模型</DialogTitle>
            <DialogDescription>只填写显示名称和 LiteLLM 模型名称即可。</DialogDescription>
          </DialogHeader>
          <div className="form-grid">
            <div className="field">
              <Label htmlFor="model-name">显示名称</Label>
              <Input
                id="model-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="field">
              <Label htmlFor="model-tag">LiteLLM 模型名称</Label>
              <Input
                id="model-tag"
                placeholder="openai/gpt-4.1"
                value={tag}
                onChange={(event) => setTag(event.target.value)}
              />
            </div>
            {create.error ? (
              <p className="text-sm text-destructive">{create.error.message}</p>
            ) : null}
          </div>
          <DialogFooter showCloseButton>
            <Button
              disabled={name.trim().length === 0 || tag.trim().length === 0 || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? "正在添加…" : "添加"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

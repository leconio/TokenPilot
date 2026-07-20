"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  applicationApiPath,
  useCurrentApplicationSlug,
} from "@/features/applications/use-current-application";
import { DataTable, type DataColumn } from "@/features/shared/components/data-table";
import { PageHeading } from "@/features/shared/components/page-heading";
import { PageState } from "@/features/shared/components/page-state";
import { StatusBadge } from "@/features/shared/components/status-badge";
import { controlApi } from "@/lib/api";
import type { CallConnection } from "./connection-types";
import { ModelSectionNav } from "./model-section-nav";

type ModelTaskType = "chat" | "embedding" | "image" | "audio";
type ModelCapability =
  | "streaming"
  | "tools"
  | "structured_output"
  | "image_input"
  | "audio_input"
  | "audio_output"
  | "cache_metering";

interface ModelDefinition {
  readonly id: string;
  readonly name: string;
  readonly request_model: string;
  readonly provider: string;
  readonly task_type: ModelTaskType;
  readonly capabilities: readonly ModelCapability[];
  readonly connection: Pick<CallConnection, "id" | "name" | "driver" | "enabled" | "status">;
  readonly enabled: boolean;
}

interface ModelList {
  readonly models: readonly ModelDefinition[];
  readonly next_cursor: string | null;
}

const taskLabels: Readonly<Record<ModelTaskType, string>> = {
  chat: "对话",
  embedding: "向量",
  image: "图片",
  audio: "语音",
};

const capabilityLabels: Readonly<Record<ModelCapability, string>> = {
  streaming: "流式返回",
  tools: "工具调用",
  structured_output: "结构化输出",
  image_input: "图片输入",
  audio_input: "语音输入",
  audio_output: "语音输出",
  cache_metering: "缓存计量",
};

const columns: DataColumn<ModelDefinition>[] = [
  {
    key: "name",
    label: "真实模型",
    cell: (model) => (
      <div className="min-w-36">
        <strong data-i18n-skip>{model.name}</strong>
        <div className="max-w-72 truncate text-xs text-muted-foreground" data-i18n-skip>
          {model.request_model}
        </div>
      </div>
    ),
  },
  {
    key: "provider",
    label: "服务商",
    cell: (model) => <span data-i18n-skip>{model.provider}</span>,
  },
  {
    key: "connection",
    label: "调用连接",
    cell: (model) => <span data-i18n-skip>{model.connection.name}</span>,
  },
  { key: "task_type", label: "用途", cell: (model) => taskLabels[model.task_type] },
  {
    key: "status",
    label: "状态",
    cell: (model) => <StatusBadge value={model.enabled ? "enabled" : "disabled"} />,
  },
];

function defaultProvider(connection: CallConnection | undefined): string {
  return connection?.driver === "anthropic" ? "anthropic" : "openai";
}

export function ModelsPage() {
  const router = useRouter();
  const applicationSlug = useCurrentApplicationSlug();
  const base = applicationApiPath(applicationSlug, "") ?? "";
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [requestModel, setRequestModel] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [provider, setProvider] = useState("openai");
  const [taskType, setTaskType] = useState<ModelTaskType>("chat");
  const [capabilities, setCapabilities] = useState<ModelCapability[]>([]);
  const models = useQuery({
    queryKey: ["models", applicationSlug],
    queryFn: () => controlApi<ModelList>(`${base}/models`),
    enabled: applicationSlug.length > 0,
  });
  const connections = useQuery({
    queryKey: ["call-connections", applicationSlug],
    queryFn: () => controlApi<{ connections: readonly CallConnection[] }>(`${base}/connections`),
    enabled: applicationSlug.length > 0,
  });
  const activeConnections = (connections.data?.connections ?? []).filter(
    (connection) => connection.enabled,
  );
  const create = useMutation({
    mutationFn: () =>
      controlApi<ModelDefinition>(`${base}/models`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          connection_id: connectionId,
          request_model: requestModel.trim(),
          provider: provider.trim().toLowerCase(),
          task_type: taskType,
          capabilities,
        }),
      }),
    onSuccess: async () => {
      setCreating(false);
      setName("");
      setRequestModel("");
      setConnectionId("");
      setProvider("openai");
      setTaskType("chat");
      setCapabilities([]);
      await queryClient.invalidateQueries({ queryKey: ["models", applicationSlug] });
    },
  });

  function openCreate() {
    const first = activeConnections[0];
    setConnectionId(first?.id ?? "");
    setProvider(defaultProvider(first));
    setCreating(true);
  }

  return (
    <main className="page">
      <PageHeading
        title="模型"
        description="配置应用可调用的服务、真实模型和自动分流。"
        actions={
          <Button disabled={activeConnections.length === 0} onClick={openCreate}>
            <Plus />
            添加真实模型
          </Button>
        }
      />
      <ModelSectionNav />
      {connections.isSuccess && activeConnections.length === 0 ? (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>先添加一个调用连接，再录入真实模型。</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => router.push(`/apps/${applicationSlug}/connections`)}
            >
              添加调用连接
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {models.isPending || connections.isPending ? (
        <PageState state="loading" />
      ) : models.error || connections.error ? (
        <PageState
          state="error"
          message={(models.error ?? connections.error)?.message}
          onRetry={() => {
            void models.refetch();
            void connections.refetch();
          }}
        />
      ) : (
        <DataTable
          columns={columns}
          emptyMessage="先添加一个真实模型。"
          rows={[...(models.data?.models ?? [])]}
          onRowClick={(model) => router.push(`/apps/${applicationSlug}/models/${model.id}`)}
        />
      )}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加真实模型</DialogTitle>
            <DialogDescription>填写名称、模型标识和调用连接即可。</DialogDescription>
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
              <Label htmlFor="model-request-name">模型标识</Label>
              <Input
                id="model-request-name"
                placeholder="gpt-4.1-mini"
                value={requestModel}
                onChange={(event) => setRequestModel(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">填写该服务实际接收的模型名称。</p>
            </div>
            <div className="field">
              <Label htmlFor="model-connection">调用连接</Label>
              <Select
                value={connectionId}
                onValueChange={(value) => {
                  setConnectionId(value);
                  setProvider(
                    defaultProvider(
                      activeConnections.find((connection) => connection.id === value),
                    ),
                  );
                }}
              >
                <SelectTrigger className="w-full" id="model-connection">
                  <SelectValue placeholder="选择调用连接" />
                </SelectTrigger>
                <SelectContent>
                  {activeConnections.map((connection) => (
                    <SelectItem data-i18n-skip key={connection.id} value={connection.id}>
                      {connection.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button size="sm" type="button" variant="ghost">
                  更多设置
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-3 grid gap-4">
                <div className="field">
                  <Label htmlFor="model-provider">服务商标识</Label>
                  <Input
                    id="model-provider"
                    value={provider}
                    onChange={(event) => setProvider(event.target.value)}
                  />
                </div>
                <div className="field">
                  <Label htmlFor="model-task">用途</Label>
                  <Select
                    value={taskType}
                    onValueChange={(value: ModelTaskType) => setTaskType(value)}
                  >
                    <SelectTrigger className="w-full" id="model-task">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.entries(taskLabels) as Array<[ModelTaskType, string]>).map(
                        ([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <fieldset className="field">
                  <legend className="text-sm font-medium">支持能力</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(Object.entries(capabilityLabels) as Array<[ModelCapability, string]>).map(
                      ([value, label]) => (
                        <Label className="flex items-center gap-2 font-normal" key={value}>
                          <Checkbox
                            checked={capabilities.includes(value)}
                            onCheckedChange={(checked) =>
                              setCapabilities((current) =>
                                checked
                                  ? [...current, value]
                                  : current.filter((item) => item !== value),
                              )
                            }
                          />
                          {label}
                        </Label>
                      ),
                    )}
                  </div>
                </fieldset>
              </CollapsibleContent>
            </Collapsible>
            {create.error ? (
              <Alert variant="destructive">
                <AlertDescription>{create.error.message}</AlertDescription>
              </Alert>
            ) : null}
          </div>
          <DialogFooter showCloseButton>
            <Button
              disabled={
                name.trim().length === 0 ||
                requestModel.trim().length === 0 ||
                connectionId.length === 0 ||
                provider.trim().length === 0 ||
                create.isPending
              }
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

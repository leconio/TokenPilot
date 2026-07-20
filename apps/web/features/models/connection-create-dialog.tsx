"use client";

import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
  connectionDriverLabels,
  type ConnectionDriver,
  type ConnectorOption,
} from "./connection-types";

export interface CreateConnectionInput {
  readonly name: string;
  readonly driver: ConnectionDriver;
  readonly base_url: string | null;
  readonly credential_ref: string | null;
  readonly public_config: { readonly timeout_ms: number; readonly max_retries: number };
  readonly connector_instance_id?: string;
}

interface ConnectionDraft {
  readonly name: string;
  readonly driver: ConnectionDriver;
  readonly baseUrl: string;
  readonly credentialRef: string;
  readonly connectorId: string;
  readonly timeoutMs: string;
  readonly retries: string;
}

const defaultUrls: Readonly<Record<ConnectionDriver, string>> = {
  litellm: "http://litellm:4000/v1",
  openai_compatible: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

const emptyDraft: ConnectionDraft = {
  name: "",
  driver: "litellm",
  baseUrl: defaultUrls.litellm,
  credentialRef: "LITELLM_API_KEY",
  connectorId: "none",
  timeoutMs: "60000",
  retries: "2",
};

export function ConnectionCreateDialog({
  connectorOptions,
  error,
  isPending,
  onOpenChange,
  onSubmit,
  open,
}: Readonly<{
  connectorOptions: readonly ConnectorOption[];
  error: Error | null;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: CreateConnectionInput) => void;
  open: boolean;
}>) {
  const [draft, setDraft] = useState<ConnectionDraft>(emptyDraft);
  useEffect(() => {
    if (!open) setDraft(emptyDraft);
  }, [open]);

  const requiresBaseUrl = draft.driver !== "anthropic";
  const canCreate =
    draft.name.trim().length > 0 && (!requiresBaseUrl || draft.baseUrl.trim().length > 0);
  const submit = () =>
    onSubmit({
      name: draft.name.trim(),
      driver: draft.driver,
      base_url: draft.baseUrl.trim() || null,
      credential_ref: draft.credentialRef.trim() || null,
      public_config: {
        timeout_ms: Number(draft.timeoutMs),
        max_retries: Number(draft.retries),
      },
      ...(draft.driver === "litellm" && draft.connectorId !== "none"
        ? { connector_instance_id: draft.connectorId }
        : {}),
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加调用连接</DialogTitle>
          <DialogDescription>
            密钥保留在应用环境中。这里仅保存服务地址和本地密钥名称。
          </DialogDescription>
        </DialogHeader>
        <div className="form-grid">
          <div className="field">
            <Label htmlFor="connection-name">名称</Label>
            <Input
              id="connection-name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </div>
          <div className="field">
            <Label htmlFor="connection-driver">类型</Label>
            <Select
              value={draft.driver}
              onValueChange={(driver: ConnectionDriver) =>
                setDraft({
                  ...draft,
                  driver,
                  baseUrl: defaultUrls[driver],
                  credentialRef:
                    driver === "anthropic"
                      ? "ANTHROPIC_API_KEY"
                      : driver === "litellm"
                        ? "LITELLM_API_KEY"
                        : "OPENAI_API_KEY",
                  connectorId: "none",
                })
              }
            >
              <SelectTrigger className="w-full" id="connection-driver">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.entries(connectionDriverLabels) as Array<[ConnectionDriver, string]>).map(
                  ([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="field">
            <Label htmlFor="connection-url">服务地址{requiresBaseUrl ? "" : "（可选）"}</Label>
            <Input
              id="connection-url"
              inputMode="url"
              value={draft.baseUrl}
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            />
          </div>
          <div className="field">
            <Label htmlFor="credential-reference">本地密钥名称（可选）</Label>
            <Input
              autoComplete="off"
              id="credential-reference"
              value={draft.credentialRef}
              onChange={(event) => setDraft({ ...draft, credentialRef: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">例如 OPENAI_API_KEY。不要填写真实密钥。</p>
          </div>
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button size="sm" type="button" variant="ghost">
                更多设置
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 grid gap-4 sm:grid-cols-2">
              {draft.driver === "litellm" ? (
                <div className="field sm:col-span-2">
                  <Label htmlFor="connector-instance">已上报的 LiteLLM（可选）</Label>
                  <Select
                    value={draft.connectorId}
                    onValueChange={(connectorId) => setDraft({ ...draft, connectorId })}
                  >
                    <SelectTrigger className="w-full" id="connector-instance">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">暂不绑定</SelectItem>
                      {connectorOptions.map((connector) => (
                        <SelectItem key={connector.id} value={connector.id}>
                          {connector.name} ({connector.instance_id})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <div className="field">
                <Label htmlFor="connection-timeout">最长等待（毫秒）</Label>
                <Input
                  id="connection-timeout"
                  inputMode="numeric"
                  value={draft.timeoutMs}
                  onChange={(event) => setDraft({ ...draft, timeoutMs: event.target.value })}
                />
              </div>
              <div className="field">
                <Label htmlFor="connection-retries">失败重试次数</Label>
                <Input
                  id="connection-retries"
                  inputMode="numeric"
                  value={draft.retries}
                  onChange={(event) => setDraft({ ...draft, retries: event.target.value })}
                />
              </div>
            </CollapsibleContent>
          </Collapsible>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter showCloseButton>
          <Button disabled={!canCreate || isPending} onClick={submit}>
            {isPending ? "正在添加…" : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";

import { useInstanceTimezone } from "@/components/instance-timezone";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import { DataTable, type DataColumn } from "@/features/shared/components/data-table";
import { PageState } from "@/features/shared/components/page-state";
import { StatusBadge } from "@/features/shared/components/status-badge";
import { useLocale } from "@/i18n/locale-provider";
import { controlApi, jsonBody } from "@/lib/api";
import { fullDateTime } from "@/lib/time";
import type { IssuedKey, ServiceApiKey } from "./types";

const keyPurposes = [
  {
    value: "reports",
    label: "读取统计数据",
    scopes: ["usage:read", "model:read", "pricing:read", "reports:read"],
  },
  {
    value: "ingestion",
    label: "上传模型用量",
    scopes: ["usage:write", "connector:heartbeat"],
  },
  {
    value: "routing",
    label: "同步调用策略",
    scopes: ["runtime:read", "runtime:write", "runtime:ack"],
  },
  {
    value: "administration",
    label: "管理全部配置",
    scopes: [
      "usage:read",
      "model:read",
      "model:write",
      "configuration:read",
      "configuration:write",
      "admin:read",
      "admin:write",
      "pricing:read",
      "pricing:write",
      "reports:read",
      "jobs:read",
      "jobs:write",
      "reconciliation:read",
      "reconciliation:write",
    ],
  },
] as const;

type KeyPurpose = (typeof keyPurposes)[number]["value"];

function purposeLabel(scopes: readonly string[]): string {
  if (scopes.includes("usage:write")) return "上传模型用量";
  if (scopes.includes("runtime:read")) return "同步分流配置";
  if (scopes.includes("admin:write")) return "管理全部配置";
  if (scopes.includes("reports:read")) return "读取统计数据";
  return "自定义用途";
}

export function ApiKeysPanel() {
  const { locale } = useLocale();
  const pathname = usePathname();
  const applicationSlug = /^\/apps\/([^/]+)/u.exec(pathname)?.[1] ?? "";
  const keysPath = `/applications/${applicationSlug}/service-api-keys`;
  const timezone = useInstanceTimezone();
  const client = useQueryClient();
  const keys = useQuery({
    queryKey: ["service-api-keys", applicationSlug],
    queryFn: () => controlApi<ServiceApiKey[]>(keysPath),
    enabled: applicationSlug.length > 0,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState<KeyPurpose>("reports");
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  const [revoke, setRevoke] = useState<ServiceApiKey | null>(null);
  const create = useMutation({
    mutationFn: () => {
      const selected = keyPurposes.find((item) => item.value === purpose) ?? keyPurposes[0];
      return controlApi<IssuedKey>(keysPath, {
        method: "POST",
        ...jsonBody({
          name,
          scopes: [...selected.scopes],
          expires_at: null,
          reason: `在网页中创建访问密钥：${name}`,
        }),
      });
    },
    onSuccess: async (value) => {
      setIssued(value);
      setCreateOpen(false);
      setName("");
      setPurpose("reports");
      await client.invalidateQueries({ queryKey: ["service-api-keys", applicationSlug] });
    },
  });
  const revokeKey = useMutation({
    mutationFn: ({ id, reason: auditReason }: { id: string; reason: string }) =>
      controlApi<ServiceApiKey>(`${keysPath}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        ...jsonBody({ reason: auditReason }),
      }),
    onSuccess: async () => {
      setRevoke(null);
      await client.invalidateQueries({ queryKey: ["service-api-keys", applicationSlug] });
    },
  });
  const columns: DataColumn<ServiceApiKey>[] = [
    { key: "name", label: "名称", cell: (row) => <strong>{row.name}</strong> },
    {
      key: "purpose",
      label: "用途",
      cell: (row) => purposeLabel(row.scopes),
      exportValue: (row) => purposeLabel(row.scopes),
    },
    { key: "status", label: "状态", cell: (row) => <StatusBadge value={row.status} /> },
    {
      key: "last_used",
      label: "最近使用",
      cell: (row) => {
        const value = row.lastUsedAt ?? row.last_used_at;
        return value ? fullDateTime(value, timezone, locale) : "尚未使用";
      },
    },
    {
      key: "action",
      label: "",
      cell: (row) =>
        row.status.toLowerCase() === "active" ? (
          <Button
            size="sm"
            variant="destructive"
            onClick={(event) => {
              event.stopPropagation();
              setRevoke(row);
            }}
          >
            <Trash2 />
            停用
          </Button>
        ) : (
          "-"
        ),
    },
  ];
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>访问密钥</CardTitle>
          <CardDescription>供程序接入使用，完整密钥只在创建后显示一次。</CardDescription>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <KeyRound />
          创建密钥
        </Button>
      </CardHeader>
      <CardContent>
        {keys.isPending ? (
          <PageState state="loading" />
        ) : keys.isError ? (
          <PageState
            state="error"
            message={keys.error.message}
            onRetry={() => void keys.refetch()}
          />
        ) : (
          <DataTable
            columns={columns}
            rows={keys.data}
            showColumnSelector={false}
            showExport={false}
          />
        )}
      </CardContent>
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>创建访问密钥</DialogTitle>
            <DialogDescription>选择用途后，系统会自动授予完成该用途所需的权限。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-2">
              <Label htmlFor="key-name">名称</Label>
              <Input id="key-name" value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="key-purpose">用途</Label>
              <Select value={purpose} onValueChange={(value) => setPurpose(value as KeyPurpose)}>
                <SelectTrigger id="key-purpose">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {keyPurposes.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {create.error ? (
              <Alert variant="destructive">
                <AlertDescription>{create.error.message}</AlertDescription>
              </Alert>
            ) : null}
          </div>
          <DialogFooter>
            <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
              创建密钥
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {issued ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setIssued(null);
          }}
        >
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>请立即保存访问密钥</DialogTitle>
              <DialogDescription>关闭后无法再次读取。</DialogDescription>
            </DialogHeader>
            <Textarea readOnly value={issued.api_key} />
            <DialogFooter>
              <Button onClick={() => setIssued(null)}>关闭</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {revoke ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setRevoke(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>停用访问密钥</DialogTitle>
              <DialogDescription>停用 {revoke.name} 会立即生效且不可恢复。</DialogDescription>
            </DialogHeader>
            {revokeKey.error ? (
              <Alert variant="destructive">
                <AlertDescription>{revokeKey.error.message}</AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              {revokeKey.error && revokeKey.variables ? (
                <Button variant="outline" onClick={() => revokeKey.mutate(revokeKey.variables!)}>
                  重试
                </Button>
              ) : null}
              <Button
                disabled={revokeKey.isPending}
                variant="destructive"
                onClick={() =>
                  revokeKey.mutate({
                    id: revoke.id,
                    reason: `在网页中停用访问密钥：${revoke.name}`,
                  })
                }
              >
                确认停用
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </Card>
  );
}

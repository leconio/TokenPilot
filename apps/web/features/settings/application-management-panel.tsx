"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Pencil, Plus, Power } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type DataColumn } from "@/features/shared/components/data-table";
import { PageState } from "@/features/shared/components/page-state";
import { useCurrentApplicationSlug } from "@/features/applications/use-current-application";
import { useLocale } from "@/i18n/locale-provider";
import { controlApi, jsonBody } from "@/lib/api";

import {
  ArchiveApplicationDialog,
  ChangeApplicationStatusDialog,
  CreateApplicationDialog,
  EditApplicationDialog,
} from "./application-dialogs";
import { ApplicationMembersPanel } from "./application-members-panel";
import type { ManagedApplication } from "./types";

interface ManagedApplicationList {
  readonly applications: readonly ManagedApplication[];
}

export function ApplicationManagementPanel() {
  const { text } = useLocale();
  const currentSlug = useCurrentApplicationSlug();
  const router = useRouter();
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ManagedApplication | null>(null);
  const [changingStatus, setChangingStatus] = useState<ManagedApplication | null>(null);
  const [archiving, setArchiving] = useState<ManagedApplication | null>(null);
  const applications = useQuery({
    queryKey: ["application-management"],
    queryFn: () => controlApi<ManagedApplicationList>("/applications/manage"),
  });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["application-management"] }),
      client.invalidateQueries({ queryKey: ["applications"] }),
    ]);
  };
  const create = useMutation({
    mutationFn: (name: string) =>
      controlApi<ManagedApplication>("/applications", {
        method: "POST",
        ...jsonBody({ name }),
      }),
    onSuccess: async () => {
      setCreating(false);
      await refresh();
    },
  });
  const edit = useMutation({
    mutationFn: (value: {
      application: ManagedApplication;
      changes: { name: string; timezone: string; base_currency: string };
    }) =>
      controlApi<ManagedApplication>(
        `/applications/manage/${encodeURIComponent(value.application.slug)}`,
        { method: "PATCH", ...jsonBody(value.changes) },
      ),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });
  const status = useMutation({
    mutationFn: (application: ManagedApplication) =>
      controlApi<ManagedApplication>(
        `/applications/manage/${encodeURIComponent(application.slug)}`,
        {
          method: "PATCH",
          ...jsonBody({ status: application.status === "active" ? "disabled" : "active" }),
        },
      ),
    onSuccess: async (_, application) => {
      setChangingStatus(null);
      await refresh();
      if (application.slug === currentSlug) router.replace("/apps");
    },
  });
  const archive = useMutation({
    mutationFn: (value: {
      application: ManagedApplication;
      confirmationName: string;
      reason: string;
    }) =>
      controlApi<{ archived: true }>(
        `/applications/${encodeURIComponent(value.application.slug)}/archive`,
        {
          method: "POST",
          ...jsonBody({ confirmation_name: value.confirmationName, reason: value.reason }),
        },
      ),
    onSuccess: async (_, value) => {
      setArchiving(null);
      await refresh();
      if (value.application.slug === currentSlug) router.replace("/apps");
    },
  });
  const current = applications.data?.applications.find((item) => item.slug === currentSlug);
  const columns: DataColumn<ManagedApplication>[] = [
    {
      key: "name",
      label: "应用",
      cell: (row) => (
        <div className="grid">
          <strong data-i18n-skip>{row.name}</strong>
          <span className="text-muted-foreground">
            {row.member_count ?? 0} {text("位成员", "members")}
          </span>
        </div>
      ),
    },
    {
      key: "status",
      label: "状态",
      cell: (row) => (
        <Badge variant={row.status === "active" ? "secondary" : "outline"}>
          {row.archived_at ? "已归档" : row.status === "active" ? "可用" : "已停用"}
        </Badge>
      ),
    },
    {
      key: "role",
      label: "我的角色",
      cell: (row) =>
        ({ owner: "所有者", admin: "管理员", analyst: "数据分析成员", viewer: "只读成员" })[
          row.role
        ],
    },
    {
      key: "actions",
      label: "",
      cell: (row) => {
        const canManage = row.permissions.includes("admin:write");
        if (!canManage || row.archived_at) return null;
        return (
          <div className="flex justify-end gap-2">
            <Button
              aria-label={`${text("编辑应用", "Edit application")} ${row.name}`}
              size="icon-sm"
              variant="outline"
              onClick={(event) => {
                event.stopPropagation();
                setEditing(row);
              }}
            >
              <Pencil />
            </Button>
            <Button
              aria-label={`${
                row.status === "active"
                  ? text("停用应用", "Disable application")
                  : text("启用应用", "Enable application")
              } ${row.name}`}
              size="icon-sm"
              variant="outline"
              onClick={(event) => {
                event.stopPropagation();
                setChangingStatus(row);
              }}
            >
              <Power />
            </Button>
            {row.role === "owner" && row.status === "active" ? (
              <Button
                aria-label={`${text("归档应用", "Archive application")} ${row.name}`}
                size="icon-sm"
                variant="destructive"
                onClick={(event) => {
                  event.stopPropagation();
                  setArchiving(row);
                }}
              >
                <Archive />
              </Button>
            ) : null}
          </div>
        );
      },
    },
  ];

  if (applications.isPending) return <PageState state="loading" />;
  if (applications.isError) {
    return (
      <PageState
        state="error"
        message={applications.error.message}
        onRetry={() => void applications.refetch()}
      />
    );
  }
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>应用管理</CardTitle>
            <CardDescription>每个应用的数据、成员和配置彼此独立。</CardDescription>
          </div>
          <Button onClick={() => setCreating(true)}>
            <Plus />
            创建应用
          </Button>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            rows={[...applications.data.applications]}
            showColumnSelector={false}
            showExport={false}
          />
        </CardContent>
      </Card>
      {current?.status === "active" ? <ApplicationMembersPanel application={current} /> : null}
      {creating ? (
        <CreateApplicationDialog
          error={create.error}
          onOpenChange={setCreating}
          onSubmit={(name) => create.mutate(name)}
          open
          pending={create.isPending}
        />
      ) : null}
      {editing ? (
        <EditApplicationDialog
          application={editing}
          error={edit.error}
          key={editing.id}
          onClose={() => setEditing(null)}
          onSubmit={(changes) => edit.mutate({ application: editing, changes })}
          pending={edit.isPending}
        />
      ) : null}
      {changingStatus ? (
        <ChangeApplicationStatusDialog
          application={changingStatus}
          error={status.error}
          onClose={() => setChangingStatus(null)}
          onConfirm={() => status.mutate(changingStatus)}
          pending={status.isPending}
        />
      ) : null}
      {archiving ? (
        <ArchiveApplicationDialog
          application={archiving}
          error={archive.error}
          key={archiving.id}
          onClose={() => setArchiving(null)}
          onSubmit={(confirmationName, reason) =>
            archive.mutate({ application: archiving, confirmationName, reason })
          }
          pending={archive.isPending}
        />
      ) : null}
    </div>
  );
}

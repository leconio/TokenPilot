"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type DataColumn } from "@/features/shared/components/data-table";
import { PageState } from "@/features/shared/components/page-state";
import { useLocale } from "@/i18n/locale-provider";
import { controlApi, jsonBody } from "@/lib/api";

import {
  AddApplicationMemberDialog,
  EditApplicationMemberDialog,
  RemoveApplicationMemberDialog,
} from "./application-member-dialogs";
import type { ApplicationMember, ApplicationRoleName, ManagedApplication } from "./types";

const roleLabels: Readonly<Record<ApplicationRoleName, string>> = {
  owner: "所有者",
  admin: "管理员",
  analyst: "数据分析成员",
  viewer: "只读成员",
};

export function ApplicationMembersPanel({
  application,
}: Readonly<{ application: ManagedApplication }>) {
  const { text } = useLocale();
  const client = useQueryClient();
  const path = `/applications/${encodeURIComponent(application.slug)}/members`;
  const queryKey = ["application-members", application.slug];
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ApplicationMember | null>(null);
  const [removing, setRemoving] = useState<ApplicationMember | null>(null);
  const members = useQuery({
    queryKey,
    queryFn: () => controlApi<{ members: readonly ApplicationMember[] }>(path),
    enabled: application.status === "active",
  });
  const add = useMutation({
    mutationFn: (value: { email: string; role: ApplicationRoleName }) =>
      controlApi<ApplicationMember>(path, { method: "POST", ...jsonBody(value) }),
    onSuccess: async () => {
      setAdding(false);
      await client.invalidateQueries({ queryKey });
      await client.invalidateQueries({ queryKey: ["application-management"] });
    },
  });
  const edit = useMutation({
    mutationFn: (value: {
      userId: string;
      role: ApplicationRoleName;
      permissions: readonly string[];
    }) =>
      controlApi<ApplicationMember>(`${path}/${encodeURIComponent(value.userId)}`, {
        method: "PATCH",
        ...jsonBody({ role: value.role, permissions: value.permissions }),
      }),
    onSuccess: async () => {
      setEditing(null);
      await client.invalidateQueries({ queryKey });
      await client.invalidateQueries({
        queryKey: ["application-capabilities", application.slug],
      });
    },
  });
  const remove = useMutation({
    mutationFn: (userId: string) =>
      controlApi<{ removed: boolean }>(`${path}/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      }),
    onSuccess: async () => {
      setRemoving(null);
      await client.invalidateQueries({ queryKey });
      await client.invalidateQueries({ queryKey: ["application-management"] });
    },
  });
  const canManage = application.role === "owner" && application.permissions.includes("admin:write");
  const columns: DataColumn<ApplicationMember>[] = [
    {
      key: "member",
      label: "成员",
      cell: (row) => (
        <div className="grid" data-i18n-skip>
          <strong>{row.name}</strong>
          <span className="text-muted-foreground">{row.email}</span>
        </div>
      ),
    },
    { key: "role", label: "角色", cell: (row) => roleLabels[row.role] },
    {
      key: "access",
      label: "可用功能",
      cell: (row) => `${row.permissions.length} ${text("项", "items")}`,
    },
    {
      key: "actions",
      label: "",
      cell: (row) =>
        canManage ? (
          <div className="flex justify-end gap-2">
            <Button
              aria-label={`${text("编辑成员", "Edit member")} ${row.name}`}
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
              aria-label={`${text("移除成员", "Remove member")} ${row.name}`}
              size="icon-sm"
              variant="destructive"
              onClick={(event) => {
                event.stopPropagation();
                setRemoving(row);
              }}
            >
              <Trash2 />
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>当前应用成员</CardTitle>
          <CardDescription>成员只会看到这个应用的数据。</CardDescription>
        </div>
        {canManage ? (
          <Button onClick={() => setAdding(true)}>
            <Plus />
            添加成员
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {members.isPending ? (
          <PageState state="loading" />
        ) : members.isError ? (
          <PageState
            state="error"
            message={members.error.message}
            onRetry={() => void members.refetch()}
          />
        ) : (
          <DataTable
            columns={columns}
            rows={[...members.data.members]}
            showColumnSelector={false}
            showExport={false}
          />
        )}
      </CardContent>
      {adding ? (
        <AddApplicationMemberDialog
          error={add.error}
          onOpenChange={setAdding}
          onSubmit={(email, role) => add.mutate({ email, role })}
          open
          pending={add.isPending}
        />
      ) : null}
      {editing ? (
        <EditApplicationMemberDialog
          error={edit.error}
          key={editing.user_id}
          member={editing}
          onClose={() => setEditing(null)}
          onSubmit={(role, permissions) =>
            edit.mutate({ userId: editing.user_id, role, permissions })
          }
          pending={edit.isPending}
        />
      ) : null}
      {removing ? (
        <RemoveApplicationMemberDialog
          error={remove.error}
          member={removing}
          onClose={() => setRemoving(null)}
          onConfirm={() => remove.mutate(removing.user_id)}
          pending={remove.isPending}
        />
      ) : null}
    </Card>
  );
}

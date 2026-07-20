"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Plus, RefreshCw, RotateCcw, Settings2, UsersRound } from "lucide-react";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useInstanceTimezone } from "@/components/instance-timezone";
import { DetailSheet } from "@/features/shared/components/detail-sheet";
import { PageHeading } from "@/features/shared/components/page-heading";
import { PageState } from "@/features/shared/components/page-state";
import { ReasonDialog } from "@/features/users/user-dialogs";
import { QuotaPolicyDialog } from "@/features/users/quota-policy-dialog";
import { controlApi } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { useLocale } from "@/i18n/locale-provider";
import { UserGroupDialog } from "./user-group-dialog";
import {
  UserGroupDetail,
  type GroupActivityReport,
  type GroupAiuReport,
  type GroupCostReport,
} from "./user-group-detail";
import type { ReportEnvelope } from "@/features/control-plane/api/types";
import type {
  AiuQuotaPolicy,
  AiuQuotaPolicyInput,
  AiuQuotaPolicyList,
} from "@/features/users/types";
import type {
  ApplicationUserGroup,
  UserGroupDefinition,
  UserGroupMember,
  UserGroupPreview,
} from "./types";

function conditionSummary(
  group: ApplicationUserGroup,
  text: (chinese: string, english: string) => string,
): string {
  const count = group.definition.conditions.length;
  return `${
    group.definition.match === "all" ? text("全部", "All") : text("任意", "Any")
  } · ${count} ${text("个条件", "conditions")}`;
}

export function UserGroupsPage() {
  const { locale, text } = useLocale();
  const timezone = useInstanceTimezone();
  const slug = /^\/apps\/([^/]+)/u.exec(usePathname())?.[1] ?? "";
  const path = `/applications/${slug}/user-groups`;
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<ApplicationUserGroup | null>(null);
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [action, setAction] = useState<"quota_reset" | "block" | "unblock" | null>(null);
  const groups = useQuery({
    queryKey: ["application-user-groups", slug],
    queryFn: () => controlApi<{ user_groups: readonly ApplicationUserGroup[] }>(path),
    enabled: slug.length > 0,
  });
  const quotaPolicies = useQuery({
    queryKey: ["aiu-quota-policies", slug],
    queryFn: () => controlApi<AiuQuotaPolicyList>(`/applications/${slug}/quota-policies`),
    enabled: slug.length > 0,
  });
  const groupQuota =
    quotaPolicies.data?.policies.find(
      (policy) =>
        policy.scope === "user_group" && policy.user_group_id === selected?.id && policy.enabled,
    ) ?? null;
  const members = useQuery({
    queryKey: [
      "application-user-group-members",
      slug,
      selected?.id,
      selected?.latest_evaluation_id,
    ],
    queryFn: () =>
      controlApi<{ members: readonly UserGroupMember[]; evaluated_at: string | null }>(
        `${path}/${selected!.id}/members`,
      ),
    enabled: selected !== null,
  });
  const reportParameters = useMemo(() => {
    const to = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const from = new Date(to.getTime() - 30 * 86_400_000);
    return new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      page_size: "200",
      group_dimension: "request_model",
      conditions: JSON.stringify([
        { kind: "builtin", field: "user_group", operator: "equals", values: [selected?.id ?? ""] },
      ]),
    });
  }, [selected?.id]);
  const groupReport = <T,>(kind: string, metric: string) =>
    controlApi<ReportEnvelope<T>>(
      `/applications/${slug}/reports/${kind}?${new URLSearchParams({ ...Object.fromEntries(reportParameters), metric })}`,
    );
  const calls = useQuery({
    queryKey: ["application-user-group-report", slug, selected?.id, "calls"],
    queryFn: () => groupReport<GroupActivityReport>("activity", "requests"),
    enabled: selected !== null,
  });
  const tokens = useQuery({
    queryKey: ["application-user-group-report", slug, selected?.id, "tokens"],
    queryFn: () => groupReport<GroupActivityReport>("activity", "tokens"),
    enabled: selected !== null,
  });
  const aiu = useQuery({
    queryKey: ["application-user-group-report", slug, selected?.id, "aiu"],
    queryFn: () => groupReport<GroupAiuReport>("aiu", "aiu"),
    enabled: selected !== null,
  });
  const costs = useQuery({
    queryKey: ["application-user-group-report", slug, selected?.id, "cost"],
    queryFn: () => groupReport<GroupCostReport>("provider-cost", "provider_cost"),
    enabled: selected !== null,
  });
  async function refresh() {
    await client.invalidateQueries({ queryKey: ["application-user-groups", slug] });
    await client.invalidateQueries({ queryKey: ["application-user-group-members", slug] });
    await client.invalidateQueries({ queryKey: ["application-user-group-report", slug] });
  }
  const create = useMutation({
    mutationFn: (body: { name: string; description?: string; definition: UserGroupDefinition }) =>
      controlApi<ApplicationUserGroup>(path, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async () => {
      setCreating(false);
      await refresh();
    },
  });
  const preview = useMutation({
    mutationFn: (definition: UserGroupDefinition) =>
      controlApi<UserGroupPreview>(`${path}/preview`, {
        method: "POST",
        body: JSON.stringify({ definition, limit: 5 }),
      }),
  });
  const evaluate = useMutation({
    mutationFn: (group: ApplicationUserGroup) =>
      controlApi(`${path}/${group.id}/evaluate`, { method: "POST" }),
    onSuccess: async () => refresh(),
  });
  const bulkAction = useMutation({
    mutationFn: ({ reason }: { reason: string }) =>
      controlApi(`${path}/${selected!.id}/actions`, {
        method: "POST",
        body: JSON.stringify({ action, reason }),
      }),
    onSuccess: async () => {
      setAction(null);
      await refresh();
    },
  });
  const saveGroupQuota = useMutation({
    mutationFn: (body: AiuQuotaPolicyInput) =>
      controlApi<AiuQuotaPolicy>(
        `/applications/${slug}/quota-policies/user-groups/${selected!.id}`,
        { method: "PUT", body: JSON.stringify(body) },
      ),
    onSuccess: async () => {
      setQuotaOpen(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["aiu-quota-policies", slug] }),
        client.invalidateQueries({ queryKey: ["application-users", slug] }),
      ]);
    },
  });
  const removeGroupQuota = useMutation({
    mutationFn: () =>
      controlApi<AiuQuotaPolicy>(
        `/applications/${slug}/quota-policies/user-groups/${selected!.id}`,
        { method: "DELETE", body: "{}" },
      ),
    onSuccess: async () => {
      setQuotaOpen(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["aiu-quota-policies", slug] }),
        client.invalidateQueries({ queryKey: ["application-users", slug] }),
      ]);
    },
  });

  return (
    <main className="page">
      <PageHeading
        title="用户组"
        description="按用户资料和用量组合条件，用于筛选、分流和批量额度操作。"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus />
            新建用户组
          </Button>
        }
      />
      {groups.isPending ? (
        <PageState state="loading" />
      ) : groups.error ? (
        <PageState state="error" message={groups.error.message} onRetry={() => groups.refetch()} />
      ) : groups.data?.user_groups.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {groups.data.user_groups.map((group) => (
            <Card className="cursor-pointer" key={group.id} onClick={() => setSelected(group)}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <CardTitle data-i18n-skip>{group.name}</CardTitle>
                  <Badge variant={group.enabled ? "outline" : "secondary"}>
                    {group.enabled ? "使用中" : "已停用"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="grid gap-3">
                <p className="text-sm text-muted-foreground">
                  {group.description ? (
                    <span data-i18n-skip>{group.description}</span>
                  ) : (
                    conditionSummary(group, text)
                  )}
                </p>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-sm">
                    <UsersRound />
                    {group.member_count} 人
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={evaluate.isPending}
                    onClick={(event) => {
                      event.stopPropagation();
                      evaluate.mutate(group);
                    }}
                  >
                    <RefreshCw />
                    刷新
                  </Button>
                </div>
                <span className="text-xs text-muted-foreground">
                  {group.evaluated_at
                    ? `更新于 ${dateTime(group.evaluated_at, timezone, locale)}`
                    : "尚未计算成员"}
                </span>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <PageState state="empty" message="还没有用户组。" />
      )}

      {selected ? (
        <DetailSheet title={selected.name} onClose={() => setSelected(null)}>
          <UserGroupDetail
            memberCount={selected.member_count}
            calls={calls.data?.data}
            tokens={tokens.data?.data}
            aiu={aiu.data?.data}
            costs={costs.data?.data}
            members={members.data?.members}
            pending={
              members.isPending ||
              calls.isPending ||
              tokens.isPending ||
              aiu.isPending ||
              costs.isPending
            }
            error={members.error ?? calls.error ?? tokens.error ?? aiu.error ?? costs.error}
            onRetry={() => {
              void Promise.all([
                members.refetch(),
                calls.refetch(),
                tokens.refetch(),
                aiu.refetch(),
                costs.refetch(),
              ]);
            }}
            actions={
              <>
                <Button variant="outline" onClick={() => evaluate.mutate(selected)}>
                  <RefreshCw />
                  刷新成员
                </Button>
                <Button variant="outline" onClick={() => setAction("quota_reset")}>
                  <RotateCcw />
                  重置额度
                </Button>
                <Button
                  variant="outline"
                  disabled={selected.latest_evaluation_id === null}
                  onClick={() => setQuotaOpen(true)}
                >
                  <Settings2 />
                  {groupQuota === null
                    ? text("设置组额度", "Set group allowance")
                    : text("修改组额度", "Edit group allowance")}
                </Button>
                <Button variant="destructive" onClick={() => setAction("block")}>
                  <Ban />
                  停止调用
                </Button>
                <Button variant="outline" onClick={() => setAction("unblock")}>
                  恢复调用
                </Button>
              </>
            }
          />
        </DetailSheet>
      ) : null}
      <UserGroupDialog
        open={creating}
        pending={create.isPending}
        error={create.error?.message}
        preview={preview.data}
        previewPending={preview.isPending}
        previewError={preview.error?.message}
        onOpenChange={(open) => {
          setCreating(open);
          if (!open) preview.reset();
        }}
        onPreview={(definition) => preview.mutate(definition)}
        onSubmit={(body) => create.mutate(body)}
      />
      <QuotaPolicyDialog
        open={quotaOpen && selected !== null}
        title={text("用户组 AIU 额度", "User-group AIU allowance")}
        description={text(
          "当前固定成员中的每个用户分别享有这份额度；个人额度仍然优先生效。",
          "Each current member receives this allowance independently; a user-specific allowance still takes precedence.",
        )}
        policy={groupQuota}
        showPriority
        pending={saveGroupQuota.isPending}
        removing={removeGroupQuota.isPending}
        error={saveGroupQuota.error?.message ?? removeGroupQuota.error?.message}
        onClose={() => setQuotaOpen(false)}
        onSubmit={(body) => saveGroupQuota.mutate(body)}
        onRemove={groupQuota === null ? undefined : () => removeGroupQuota.mutate()}
      />
      <ReasonDialog
        title={
          action === "quota_reset"
            ? "重置用户组额度"
            : action === "unblock"
              ? "恢复用户组调用"
              : "停止用户组调用"
        }
        description="操作使用当前固定成员快照，成员在执行过程中不会变化。"
        open={action !== null}
        pending={bulkAction.isPending}
        error={bulkAction.error?.message}
        destructive={action === "block"}
        onClose={() => setAction(null)}
        onSubmit={(reason) => bulkAction.mutate({ reason })}
      />
    </main>
  );
}

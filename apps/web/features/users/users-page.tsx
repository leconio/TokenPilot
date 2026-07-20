"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Pencil, Plus, RotateCcw, Settings2 } from "lucide-react";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useInstanceTimezone } from "@/components/instance-timezone";
import { DetailSheet } from "@/features/shared/components/detail-sheet";
import { PageHeading } from "@/features/shared/components/page-heading";
import { controlApi } from "@/lib/api";
import { useLocale } from "@/i18n/locale-provider";
import { CreateUserDialog, EditUserDialog, QuotaDialog, ReasonDialog } from "./user-dialogs";
import { DefaultQuotaCard } from "./default-quota-card";
import type { UserAdvancedFilterValues } from "./user-advanced-filters";
import { UserDetail } from "./user-detail";
import { UserFilters } from "./user-filters";
import { applicationUserDisplayName, applicationUserListParameters } from "./user-list";
import { QuotaPolicyDialog } from "./quota-policy-dialog";
import { UserTable } from "./user-table";
import type {
  AiuQuotaPolicy,
  AiuQuotaPolicyInput,
  AiuQuotaPolicyList,
  ApplicationUser,
  UserAnalytics,
  UserLedgerEntry,
  UserList,
} from "./types";
import type { PropertyList } from "@/features/properties/types";

const emptyAdvancedFilters: UserAdvancedFilterValues = {
  minCalls: "",
  minTokens: "",
  minAiu: "",
  propertyKey: "",
  propertyValue: "",
  propertyDataType: "",
};

export function UsersPage() {
  const { text } = useLocale();
  const timezone = useInstanceTimezone();
  const slug = /^\/apps\/([^/]+)/u.exec(usePathname())?.[1] ?? "";
  const path = `/applications/${slug}/users`;
  const client = useQueryClient();
  const [page, setPage] = useState(1);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [tag, setTag] = useState("");
  const [status, setStatus] = useState("all");
  const [groupId, setGroupId] = useState("all");
  const [advancedDraft, setAdvancedDraft] = useState(emptyAdvancedFilters);
  const [advanced, setAdvanced] = useState(emptyAdvancedFilters);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<ApplicationUser | null>(null);
  const [editing, setEditing] = useState<ApplicationUser | null>(null);
  const [quotaUser, setQuotaUser] = useState<ApplicationUser | null>(null);
  const [defaultQuotaOpen, setDefaultQuotaOpen] = useState(false);
  const [reasonAction, setReasonAction] = useState<"reset" | "block" | null>(null);
  const users = useQuery({
    queryKey: ["application-users", slug, page, search, status, tag, groupId, advanced],
    queryFn: () => {
      const parameters = applicationUserListParameters({
        page,
        search,
        status,
        tag,
        groupId,
        ...advanced,
      });
      return controlApi<UserList>(`${path}?${parameters}`);
    },
    enabled: slug.length > 0,
  });
  const groups = useQuery({
    queryKey: ["application-user-groups", slug, "user-filter"],
    queryFn: () =>
      controlApi<{
        user_groups: readonly { id: string; name: string; latest_evaluation_id: string | null }[];
      }>(`/applications/${slug}/user-groups`),
    enabled: slug.length > 0,
  });
  const properties = useQuery({
    queryKey: ["properties", slug],
    queryFn: () => controlApi<PropertyList>(`/applications/${slug}/properties`),
    enabled: slug.length > 0,
  });
  const quotaPolicies = useQuery({
    queryKey: ["aiu-quota-policies", slug],
    queryFn: () => controlApi<AiuQuotaPolicyList>(`/applications/${slug}/quota-policies`),
    enabled: slug.length > 0,
  });
  const defaultQuota =
    quotaPolicies.data?.policies.find(
      (policy) => policy.scope === "application" && policy.enabled,
    ) ?? null;
  const ledger = useQuery({
    queryKey: ["application-user-ledger", slug, selected?.id],
    queryFn: () =>
      controlApi<{ entries: readonly UserLedgerEntry[] }>(`${path}/${selected!.id}/aiu-ledger`),
    enabled: selected !== null,
  });
  const analytics = useQuery({
    queryKey: ["application-user-analytics", slug, selected?.id],
    queryFn: () => controlApi<UserAnalytics>(`${path}/${selected!.id}/analytics`),
    enabled: selected !== null,
  });
  async function refresh(updated?: ApplicationUser) {
    await client.invalidateQueries({ queryKey: ["application-users", slug] });
    await client.invalidateQueries({ queryKey: ["application-user-analytics", slug] });
    if (updated) setSelected(updated);
  }
  const create = useMutation({
    mutationFn: (body: { user_id: string; display_user?: string }) =>
      controlApi<ApplicationUser>(path, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async (user) => {
      setCreating(false);
      await refresh(user);
    },
  });
  const saveQuota = useMutation({
    mutationFn: (body: {
      limit: string;
      hard_limit: boolean;
      period: string;
      starts_at?: string;
      ends_at?: string;
    }) =>
      controlApi<ApplicationUser>(`${path}/${quotaUser!.id}/quota`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: async (user) => {
      setQuotaUser(null);
      await refresh(user);
    },
  });
  const saveDefaultQuota = useMutation({
    mutationFn: (body: AiuQuotaPolicyInput) =>
      controlApi<AiuQuotaPolicy>(`/applications/${slug}/quota-policies/application`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      setDefaultQuotaOpen(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["aiu-quota-policies", slug] }),
        client.invalidateQueries({ queryKey: ["application-users", slug] }),
      ]);
    },
  });
  const removeDefaultQuota = useMutation({
    mutationFn: () =>
      controlApi<AiuQuotaPolicy>(`/applications/${slug}/quota-policies/application`, {
        method: "DELETE",
        body: "{}",
      }),
    onSuccess: async () => {
      setDefaultQuotaOpen(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["aiu-quota-policies", slug] }),
        client.invalidateQueries({ queryKey: ["application-users", slug] }),
      ]);
    },
  });
  const edit = useMutation({
    mutationFn: (body: { display_user: string | null; tags: readonly string[] }) =>
      controlApi<ApplicationUser>(`${path}/${editing!.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: async (user) => {
      setEditing(null);
      await refresh(user);
    },
  });
  const reset = useMutation({
    mutationFn: (reason: string) =>
      controlApi<ApplicationUser>(`${path}/${selected!.id}/quota/reset`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
    onSuccess: async (user) => {
      setReasonAction(null);
      await refresh(user);
      await ledger.refetch();
    },
  });
  const block = useMutation({
    mutationFn: (reason: string) =>
      controlApi<ApplicationUser>(`${path}/${selected!.id}`, {
        method: "PATCH",
        body: JSON.stringify({ blocked: selected!.status !== "blocked", reason }),
      }),
    onSuccess: async (user) => {
      setReasonAction(null);
      await refresh(user);
    },
  });
  return (
    <main className="page">
      <PageHeading
        title="用户"
        description="用户随模型调用自动进入列表，也可以在这里手动添加。"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus />
            添加用户
          </Button>
        }
      />
      <div className="grid gap-4">
        <DefaultQuotaCard policy={defaultQuota} onEdit={() => setDefaultQuotaOpen(true)} />
        <UserFilters
          search={searchDraft}
          tag={tagDraft}
          status={status}
          groupId={groupId}
          groups={groups.data?.user_groups ?? []}
          advanced={advancedDraft}
          properties={properties.data?.properties ?? []}
          onSearchChange={setSearchDraft}
          onTagChange={setTagDraft}
          onStatusChange={(value) => {
            setPage(1);
            setStatus(value);
          }}
          onGroupChange={(value) => {
            setPage(1);
            setGroupId(value);
          }}
          onAdvancedChange={setAdvancedDraft}
          onSubmit={() => {
            setPage(1);
            setSearch(searchDraft.trim());
            setTag(tagDraft.trim());
            setAdvanced(advancedDraft);
          }}
          onReset={() => {
            setPage(1);
            setSearchDraft("");
            setSearch("");
            setTagDraft("");
            setTag("");
            setStatus("all");
            setGroupId("all");
            setAdvancedDraft(emptyAdvancedFilters);
            setAdvanced(emptyAdvancedFilters);
          }}
        />
        <UserTable
          data={users.data}
          error={users.error}
          pending={users.isPending}
          onPageChange={setPage}
          onRetry={() => users.refetch()}
          onRowClick={setSelected}
        />
      </div>
      {selected ? (
        <DetailSheet title={applicationUserDisplayName(selected)} onClose={() => setSelected(null)}>
          <UserDetail
            user={selected}
            analytics={analytics.data}
            analyticsPending={analytics.isPending}
            analyticsError={analytics.error}
            onAnalyticsRetry={() => analytics.refetch()}
            ledger={ledger.data?.entries}
            ledgerPending={ledger.isPending}
            ledgerError={ledger.error}
            onLedgerRetry={() => ledger.refetch()}
            timezone={timezone}
            actions={
              <>
                <Button variant="outline" onClick={() => setEditing(selected)}>
                  <Pencil />
                  编辑资料
                </Button>
                <Button variant="outline" onClick={() => setQuotaUser(selected)}>
                  <Settings2 />
                  设置额度
                </Button>
                <Button variant="outline" onClick={() => setReasonAction("reset")}>
                  <RotateCcw />
                  重置额度
                </Button>
                <Button
                  variant={selected.status === "blocked" ? "outline" : "destructive"}
                  onClick={() => setReasonAction("block")}
                >
                  <Ban />
                  {selected.status === "blocked" ? "恢复调用" : "停止调用"}
                </Button>
              </>
            }
          />
        </DetailSheet>
      ) : null}
      <CreateUserDialog
        open={creating}
        pending={create.isPending}
        error={create.error?.message}
        onOpenChange={setCreating}
        onSubmit={(body) => create.mutate(body)}
      />
      <EditUserDialog
        user={editing}
        pending={edit.isPending}
        error={edit.error?.message}
        onClose={() => setEditing(null)}
        onSubmit={(body) => edit.mutate(body)}
      />
      <QuotaDialog
        user={quotaUser}
        pending={saveQuota.isPending}
        error={saveQuota.error?.message}
        onClose={() => setQuotaUser(null)}
        onSubmit={(body) => saveQuota.mutate(body)}
      />
      <QuotaPolicyDialog
        open={defaultQuotaOpen}
        title={text("默认 AIU 额度", "Default AIU allowance")}
        description={text(
          "当前应用中的每个用户分别享有这份额度，单独设置的用户或用户组规则优先生效。",
          "Each user in this application receives this allowance independently. User and group rules take precedence.",
        )}
        policy={defaultQuota}
        pending={saveDefaultQuota.isPending}
        removing={removeDefaultQuota.isPending}
        error={saveDefaultQuota.error?.message ?? removeDefaultQuota.error?.message}
        onClose={() => setDefaultQuotaOpen(false)}
        onSubmit={(body) => saveDefaultQuota.mutate(body)}
        onRemove={defaultQuota === null ? undefined : () => removeDefaultQuota.mutate()}
      />
      <ReasonDialog
        title="重置额度"
        description="已用和预留会归零，历史记录仍会保留。"
        open={reasonAction === "reset"}
        pending={reset.isPending}
        error={reset.error?.message}
        onClose={() => setReasonAction(null)}
        onSubmit={(reason) => reset.mutate(reason)}
      />
      <ReasonDialog
        title={selected?.status === "blocked" ? "恢复调用" : "停止调用"}
        description={
          selected?.status === "blocked"
            ? "恢复后可以继续调用模型。"
            : "停止后 LiteLLM 会在调用模型前拒绝这个用户。"
        }
        open={reasonAction === "block"}
        pending={block.isPending}
        error={block.error?.message}
        destructive={selected?.status !== "blocked"}
        onClose={() => setReasonAction(null)}
        onSubmit={(reason) => block.mutate(reason)}
      />
    </main>
  );
}

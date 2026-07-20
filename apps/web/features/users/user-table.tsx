import { Badge } from "@/components/ui/badge";
import { useInstanceTimezone } from "@/components/instance-timezone";
import { formatAiuMicros } from "@/features/control-plane/quota/aiu-values";
import { DataTable, type DataColumn } from "@/features/shared/components/data-table";
import { PageState } from "@/features/shared/components/page-state";
import { useLocale } from "@/i18n/locale-provider";
import { dateTime, decimal } from "@/lib/format";

import { applicationUserDisplayName } from "./user-list";
import type { ApplicationUser, UserList } from "./types";

interface UserTableProps {
  readonly data: UserList | undefined;
  readonly error: Error | null;
  readonly pending: boolean;
  readonly onPageChange: (page: number) => void;
  readonly onRetry: () => void;
  readonly onRowClick: (user: ApplicationUser) => void;
}

export function UserTable({
  data,
  error,
  pending,
  onPageChange,
  onRetry,
  onRowClick,
}: UserTableProps) {
  const { locale } = useLocale();
  const timezone = useInstanceTimezone();
  const columns: DataColumn<ApplicationUser>[] = [
    {
      key: "user",
      label: "用户",
      cell: (row) => (
        <div data-i18n-skip>
          <strong>{applicationUserDisplayName(row)}</strong>
          {row.display_user ? (
            <div className="text-xs text-muted-foreground">{row.user_id}</div>
          ) : null}
          {row.tags.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {row.tags.slice(0, 3).map((userTag) => (
                <Badge key={userTag} variant="secondary">
                  {userTag}
                </Badge>
              ))}
              {row.tags.length > 3 ? <Badge variant="outline">+{row.tags.length - 3}</Badge> : null}
            </div>
          ) : null}
        </div>
      ),
    },
    { key: "tokens", label: "Token", cell: (row) => decimal(row.usage.tokens, 0) },
    {
      key: "aiu",
      label: "AIU",
      cell: (row) => formatAiuMicros(row.usage.aiu_micros, locale),
    },
    {
      key: "remaining",
      label: "剩余",
      cell: (row) => <strong>{formatAiuMicros(row.quota.remaining_aiu_micros, locale)}</strong>,
    },
    {
      key: "status",
      label: "状态",
      cell: (row) => (
        <Badge variant={row.status === "blocked" ? "destructive" : "outline"}>
          {row.status === "blocked" ? "已停止" : "正常"}
        </Badge>
      ),
    },
    {
      key: "last_seen_at",
      label: "最近调用",
      cell: (row) => dateTime(row.last_seen_at, timezone, locale),
    },
  ];

  if (pending) return <PageState state="loading" />;
  if (error) return <PageState state="error" message={error.message} onRetry={onRetry} />;

  return (
    <DataTable
      columns={columns}
      rows={[...(data?.users ?? [])]}
      emptyMessage="还没有用户。"
      onRowClick={onRowClick}
      pagination={
        data
          ? {
              page: data.page,
              pageSize: data.page_size,
              total: data.total,
              onPageChange,
            }
          : undefined
      }
    />
  );
}

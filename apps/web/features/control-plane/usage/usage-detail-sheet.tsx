import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  applicationApiPath,
  useCurrentApplicationSlug,
} from "@/features/applications/use-current-application";
import { displayValue } from "@/features/control-plane/api/client";
import { useControlQuery } from "@/features/control-plane/api/hooks";
import { DetailSheet } from "@/features/shared/components/detail-sheet";
import { StatusBadge } from "@/features/shared/components/status-badge";
import { useLocale } from "@/i18n/locale-provider";
import { dateTime } from "@/lib/format";
import { formatAiuMicros } from "../quota/aiu-values";
import type { AnalysisFieldDefinition } from "./analysis-types";
import { usageCost, type UsageRow } from "./usage-row";

interface RequestAttemptEvidence {
  readonly attempt_id: string;
  readonly raw_event: {
    readonly event_id: string;
    readonly processing_status: string | null;
    readonly payload_state: "retained" | "purged";
    readonly error: string | null;
    readonly payload: unknown;
  };
  readonly model_resolution: { readonly status: string };
  readonly model_cost: {
    readonly status: string;
    readonly version_id: string | null;
    readonly lines: readonly unknown[];
  } | null;
  readonly aiu: {
    readonly status: string;
    readonly version_id: string | null;
    readonly lines: readonly unknown[];
  } | null;
  readonly aiu_history: readonly unknown[];
  readonly projection: readonly { readonly status: string | null }[];
  readonly failures: readonly unknown[];
}

interface RequestEvidence {
  readonly attempts: readonly RequestAttemptEvidence[];
}

function token(value: string): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? new Intl.NumberFormat().format(numeric) : value;
}

function Definition({ label, value }: Readonly<{ label: string; value: React.ReactNode }>) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function EvidenceDetails({ label, value }: Readonly<{ label: string; value: unknown }>) {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
    return null;
  }
  return (
    <details className="rounded-lg border px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium">{label}</summary>
      <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-3 text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

export function UsageDetailSheet({
  row,
  timezone,
  userLabel,
  propertyFields,
  onClose,
}: Readonly<{
  row: UsageRow;
  timezone: string;
  userLabel: (id: string) => string;
  propertyFields: readonly AnalysisFieldDefinition[];
  onClose: () => void;
}>) {
  const { locale, text } = useLocale();
  const applicationSlug = useCurrentApplicationSlug();
  const details = useControlQuery<RequestEvidence>(
    ["request-details", applicationSlug, row.request_id],
    applicationApiPath(applicationSlug, `/requests/${encodeURIComponent(row.request_id)}`),
    undefined,
    { retry: false },
  );
  const evidence = details.data?.attempts.find(
    (attempt) =>
      attempt.raw_event.event_id === row.event_id || attempt.attempt_id === row.attempt_id,
  );
  const propertyDefinitions = new Map(
    propertyFields.map((field) => [`${field.scope}:${field.key}`, field]),
  );
  const properties = [
    ...Object.entries(row.event_properties).map(([key, value]) => ({ scope: "event", key, value })),
    ...Object.entries(row.user_properties).map(([key, value]) => ({ scope: "user", key, value })),
  ];
  return (
    <DetailSheet title="调用详情" onClose={onClose}>
      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle>本次调用</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="definition">
              <Definition label="时间" value={dateTime(row.event_time, timezone, locale)} />
              <Definition label="用户" value={row.display_user ?? userLabel(row.user_id)} />
              <Definition label="用户 ID" value={row.user_id} />
              <Definition label="请求 ID" value={row.request_id} />
              <Definition label="事件 ID" value={row.event_id} />
              <Definition label="尝试 ID" value={row.attempt_id} />
              <Definition label="操作 ID" value={row.operation_id ?? "-"} />
              <Definition label="虚拟模型" value={row.virtual_model ?? "-"} />
              <Definition label="模型" value={row.model_tag} />
              <Definition label="模型 ID" value={row.model_id ?? "-"} />
              <Definition label="模型服务" value={row.provider ?? "-"} />
              <Definition label="调用结果" value={<StatusBadge value={row.status} />} />
              <Definition label="调用原因" value={row.route_reason ?? "-"} />
              <Definition label="降级来源" value={row.fallback_from ?? "-"} />
              <Definition
                label="耗时"
                value={row.latency_ms === null ? "-" : `${row.latency_ms} ms`}
              />
              <Definition label="模型花费" value={usageCost(row)} />
              <Definition label="AIU" value={formatAiuMicros(row.aiu_micros, locale)} />
              <Definition label="额度结果" value={row.quota_status ?? "-"} />
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Token</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="definition">
              <Definition label="输入" value={token(row.input_tokens)} />
              <Definition label="缓存输入" value={token(row.cached_input_tokens)} />
              <Definition label="输出" value={token(row.output_tokens)} />
              <Definition label="推理输出" value={token(row.reasoning_output_tokens)} />
              <Definition label="合计" value={token(row.total_tokens)} />
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>接入信息</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="definition">
              <Definition
                label="接收时间"
                value={row.received_at === null ? "-" : dateTime(row.received_at, timezone, locale)}
              />
              <Definition label="数据格式版本" value={row.schema_version} />
              <Definition label="应用版本" value={row.application_version ?? "-"} />
              <Definition label="SDK 版本" value={row.sdk_version ?? "-"} />
              <Definition label="接入版本" value={row.connector_version ?? "-"} />
              <Definition label="配置版本" value={row.config_version ?? "-"} />
              <Definition label="会话 ID" value={row.session_id ?? "-"} />
              <Definition label="链路 ID" value={row.trace_id ?? "-"} />
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>处理证据</CardTitle>
          </CardHeader>
          <CardContent>
            {details.isPending ? (
              <p className="text-sm text-muted-foreground">正在读取处理结果…</p>
            ) : details.isError ? (
              <p className="text-sm text-destructive">{details.error.message}</p>
            ) : evidence === undefined ? (
              <p className="text-sm text-muted-foreground">暂时没有找到这次调用的处理记录。</p>
            ) : (
              <div className="grid gap-3">
                <dl className="definition">
                  <Definition
                    label="处理状态"
                    value={<StatusBadge value={evidence.raw_event.processing_status} />}
                  />
                  <Definition
                    label="原始数据"
                    value={
                      evidence.raw_event.payload_state === "purged" ? "已按规则清理" : "已保留"
                    }
                  />
                  <Definition
                    label="模型识别"
                    value={<StatusBadge value={evidence.model_resolution.status} />}
                  />
                  <Definition
                    label="成本计算"
                    value={
                      evidence.model_cost === null ? (
                        "尚未计算"
                      ) : (
                        <StatusBadge value={evidence.model_cost.status} />
                      )
                    }
                  />
                  <Definition label="成本依据" value={evidence.model_cost?.version_id ?? "-"} />
                  <Definition
                    label="AIU 计算"
                    value={
                      evidence.aiu === null ? (
                        "尚未计算"
                      ) : (
                        <StatusBadge value={evidence.aiu.status} />
                      )
                    }
                  />
                  <Definition label="AIU 依据" value={evidence.aiu?.version_id ?? "-"} />
                  <Definition
                    label="数据同步"
                    value={`${evidence.projection.filter((item) => item.status === "sent").length} / ${evidence.projection.length} ${text("已完成", "completed")}`}
                  />
                  <Definition
                    label="额度变动"
                    value={`${evidence.aiu_history.length} ${text("条", "entries")}`}
                  />
                  <Definition
                    label="失败记录"
                    value={`${evidence.failures.length} ${text("条", "entries")}`}
                  />
                </dl>
                <EvidenceDetails label="保留的结构化字段" value={evidence.raw_event.payload} />
                <EvidenceDetails label="处理错误" value={evidence.raw_event.error} />
                <EvidenceDetails label="成本计算明细" value={evidence.model_cost?.lines} />
                <EvidenceDetails label="AIU 换算明细" value={evidence.aiu?.lines} />
                <EvidenceDetails label="额度变动明细" value={evidence.aiu_history} />
                <EvidenceDetails label="数据同步明细" value={evidence.projection} />
                <EvidenceDetails label="失败记录明细" value={evidence.failures} />
              </div>
            )}
          </CardContent>
        </Card>
        {properties.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>自定义信息</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="definition">
                {properties.map((property) => {
                  const definition = propertyDefinitions.get(`${property.scope}:${property.key}`);
                  return (
                    <Definition
                      key={`${property.scope}:${property.key}`}
                      label={definition?.label ?? property.key}
                      value={definition?.sensitive ? "已隐藏" : displayValue(property.value)}
                    />
                  );
                })}
              </dl>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </DetailSheet>
  );
}

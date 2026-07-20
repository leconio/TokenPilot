import type { UsagePageEnvelope, UsageReportItem } from "@tokenpilot/contracts";
import type { DatabaseClient } from "@tokenpilot/db";

const HIDDEN_VALUE = "[hidden]";

interface UsagePropertyDefinition {
  readonly key: string;
  readonly displayName: string;
  readonly scope: "event" | "user";
  readonly sensitive: boolean;
}

export interface UsageOutputPolicy {
  readonly definitions: readonly UsagePropertyDefinition[];
  readonly sensitiveEventKeys: ReadonlySet<string>;
  readonly sensitiveUserKeys: ReadonlySet<string>;
}

export async function loadUsageOutputPolicy(
  database: DatabaseClient,
  applicationId: string,
): Promise<UsageOutputPolicy> {
  const rows = await database.propertyDefinition.findMany({
    where: { applicationId },
    select: { key: true, displayName: true, scope: true, sensitive: true },
    orderBy: [{ scope: "asc" }, { displayName: "asc" }, { key: "asc" }],
  });
  const definitions = rows.map((row) => ({
    key: row.key,
    displayName: row.displayName,
    scope: row.scope === "EVENT" ? ("event" as const) : ("user" as const),
    sensitive: row.sensitive,
  }));
  return {
    definitions,
    sensitiveEventKeys: new Set(
      definitions
        .filter((definition) => definition.scope === "event" && definition.sensitive)
        .map((definition) => definition.key),
    ),
    sensitiveUserKeys: new Set(
      definitions
        .filter((definition) => definition.scope === "user" && definition.sensitive)
        .map((definition) => definition.key),
    ),
  };
}

function maskProperties(
  properties: Readonly<Record<string, unknown>>,
  sensitiveKeys: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [
      key,
      sensitiveKeys.has(key) ? HIDDEN_VALUE : value,
    ]),
  );
}

export function maskUsageItem(item: UsageReportItem, policy: UsageOutputPolicy): UsageReportItem {
  return {
    ...item,
    event_properties: maskProperties(item.event_properties, policy.sensitiveEventKeys),
    user_properties: maskProperties(item.user_properties, policy.sensitiveUserKeys),
  };
}

export function maskUsagePage(
  page: UsagePageEnvelope<UsageReportItem>,
  policy: UsageOutputPolicy,
): UsagePageEnvelope<UsageReportItem> {
  return { ...page, items: page.items.map((item) => maskUsageItem(item, policy)) };
}

function csvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((item) => String(item)).join("; ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function csvCell(value: unknown): string {
  let text = csvValue(value);
  if (/^[\s]*[=+\-@]/u.test(text) || /^[\t\r]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

const builtInColumns: readonly Readonly<{
  header: string;
  value: (item: UsageReportItem) => unknown;
}>[] = [
  { header: "时间", value: (item) => item.event_time },
  { header: "接收时间", value: (item) => item.received_at },
  { header: "用户 ID", value: (item) => item.user_id },
  { header: "用户名", value: (item) => item.display_user },
  { header: "请求 ID", value: (item) => item.request_id },
  { header: "事件 ID", value: (item) => item.event_id },
  { header: "尝试 ID", value: (item) => item.attempt_id },
  { header: "操作 ID", value: (item) => item.operation_id },
  { header: "会话 ID", value: (item) => item.session_id },
  { header: "对话 ID", value: (item) => item.conversation_id },
  { header: "链路 ID", value: (item) => item.trace_id },
  { header: "虚拟模型", value: (item) => item.virtual_model },
  { header: "模型 ID", value: (item) => item.model_id },
  { header: "模型", value: (item) => item.request_model },
  { header: "模型服务", value: (item) => item.provider },
  { header: "结果", value: (item) => item.status },
  { header: "调用原因", value: (item) => item.route_reason },
  { header: "降级来源", value: (item) => item.fallback_from },
  { header: "耗时（毫秒）", value: (item) => item.latency_ms },
  { header: "输入 Token", value: (item) => item.input_tokens },
  { header: "缓存输入 Token", value: (item) => item.cached_input_tokens },
  { header: "输出 Token", value: (item) => item.output_tokens },
  { header: "推理输出 Token", value: (item) => item.reasoning_output_tokens },
  { header: "Token 合计", value: (item) => item.total_tokens },
  { header: "成本状态", value: (item) => item.provider_cost_status },
  { header: "模型花费", value: (item) => item.provider_cost_amount },
  { header: "币种", value: (item) => item.provider_cost_currency },
  { header: "AIU 状态", value: (item) => item.aiu_status },
  { header: "AIU 微单位", value: (item) => item.aiu_micros },
  { header: "是否计入 AIU", value: (item) => item.aiu_chargeable },
  { header: "额度结果", value: (item) => item.quota_status },
  { header: "数据格式版本", value: (item) => item.schema_version },
  { header: "应用版本", value: (item) => item.application_version },
  { header: "SDK 版本", value: (item) => item.sdk_version },
  { header: "接入版本", value: (item) => item.connector_version },
  { header: "配置版本", value: (item) => item.config_version },
];

function csvColumns(policy: UsageOutputPolicy) {
  const propertyColumns = policy.definitions
    .filter((definition) => !definition.sensitive)
    .map((definition) => ({
      header: `${definition.scope === "event" ? "事件字段" : "用户字段"}：${definition.displayName}`,
      value: (item: UsageReportItem) =>
        (definition.scope === "event" ? item.event_properties : item.user_properties)[
          definition.key
        ],
    }));
  return [...builtInColumns, ...propertyColumns];
}

export function usageCsvHeader(policy: UsageOutputPolicy): string {
  return `\uFEFF${csvColumns(policy)
    .map((column) => csvCell(column.header))
    .join(",")}\n`;
}

export function usageItemsToCsvRows(
  items: readonly UsageReportItem[],
  policy: UsageOutputPolicy,
): string {
  if (items.length === 0) return "";
  const columns = csvColumns(policy);
  return `${items
    .map((item) => columns.map((column) => csvCell(column.value(item))).join(","))
    .join("\n")}\n`;
}

export function usageItemsToCsv(
  items: readonly UsageReportItem[],
  policy: UsageOutputPolicy,
): string {
  return `${usageCsvHeader(policy)}${usageItemsToCsvRows(items, policy)}`;
}

export function redactSensitivePropertyKeys(
  value: unknown,
  sensitiveKeys: ReadonlySet<string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitivePropertyKeys(item, sensitiveKeys));
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      sensitiveKeys.has(key) ? HIDDEN_VALUE : redactSensitivePropertyKeys(child, sensitiveKeys),
    ]),
  );
}

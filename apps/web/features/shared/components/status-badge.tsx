import { Badge } from "@/components/ui/badge";

export function StatusBadge({ value }: Readonly<{ value: unknown }>) {
  const text = String(value ?? "unknown").toLowerCase();
  const translated: Record<string, string> = {
    active: "使用中",
    available: "可用",
    applied: "已生效",
    complete: "已完成",
    completed: "已完成",
    configured: "已配置",
    degraded: "部分可用",
    disabled: "已停用",
    draft: "待发布",
    enabled: "已启用",
    error: "异常",
    failed: "失败",
    hard_denied: "已用完",
    healthy: "正常",
    inherited: "自动继承",
    missing: "缺失",
    not_checked: "未检查",
    observe: "只统计",
    pending: "处理中",
    priced: "已计价",
    published: "已发布",
    queued: "等待处理",
    received: "已收到",
    rejected: "未采用",
    retired: "已停用",
    revoked: "已停用",
    soft_exceeded: "即将用完",
    stale: "待更新",
    success: "成功",
    unknown: "未知",
    unavailable: "不可用",
    unpriced: "未设置成本",
    unrated: "未计算 AIU",
  };
  const tone = /active|healthy|success|priced|applied|complete|published|configured/u.test(text)
    ? "badge-green"
    : /draft|queued|pending|degraded|inherited|observe/u.test(text)
      ? "badge-amber"
      : /fail|error|unavailable|unpriced|unrated|missing|stale|revoked|rejected|exceeded/u.test(
            text,
          )
        ? "badge-red"
        : "badge-blue";
  return (
    <Badge className={`badge ${tone}`} variant="outline">
      {translated[text] ?? "其他状态"}
    </Badge>
  );
}

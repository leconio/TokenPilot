"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useLocale } from "@/i18n/locale-provider";

import type { AiuQuotaPeriod, AiuQuotaPolicy, AiuQuotaPolicyInput } from "./types";

const aiuPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/u;

function aiuUnits(micros: string): string {
  const value = BigInt(micros);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

function localDateTime(value: string | null): string {
  if (value === null) return "";
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return "";
  return new Date(instant.getTime() - instant.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

export function QuotaPolicyDialog({
  open,
  title,
  description,
  policy,
  showPriority = false,
  pending,
  removing,
  error,
  onClose,
  onSubmit,
  onRemove,
}: Readonly<{
  open: boolean;
  title: string;
  description: string;
  policy: AiuQuotaPolicy | null;
  showPriority?: boolean;
  pending: boolean;
  removing: boolean;
  error?: string | undefined;
  onClose: () => void;
  onSubmit: (input: AiuQuotaPolicyInput) => void;
  onRemove: (() => void) | undefined;
}>) {
  const { text } = useLocale();
  const [limit, setLimit] = useState("");
  const [period, setPeriod] = useState<AiuQuotaPeriod>("month");
  const [hardLimit, setHardLimit] = useState(false);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [priority, setPriority] = useState("0");
  useEffect(() => {
    if (!open) return;
    setLimit(policy === null ? "" : aiuUnits(policy.limit_aiu_micros));
    setPeriod(policy?.period ?? "month");
    setHardLimit(policy?.hard_limit ?? false);
    setStartsAt(localDateTime(policy?.starts_at ?? null));
    setEndsAt(localDateTime(policy?.ends_at ?? null));
    setPriority(String(policy?.priority ?? 0));
  }, [open, policy]);
  const fixedValid =
    period !== "fixed" ||
    (startsAt.length > 0 && endsAt.length > 0 && new Date(startsAt) < new Date(endsAt));
  const priorityValue = Number(priority);
  const valid =
    aiuPattern.test(limit) &&
    fixedValid &&
    Number.isInteger(priorityValue) &&
    priorityValue >= 0 &&
    priorityValue <= 10_000;
  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="form-grid">
          <div className="field">
            <Label htmlFor="policy-quota-limit">{text("每人额度", "Allowance per user")}</Label>
            <Input
              id="policy-quota-limit"
              min="0"
              step="0.000001"
              type="number"
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
            />
          </div>
          <div className="field">
            <Label htmlFor="policy-quota-period">{text("周期", "Period")}</Label>
            <Select value={period} onValueChange={(value) => setPeriod(value as AiuQuotaPeriod)}>
              <SelectTrigger className="w-full" id="policy-quota-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="month">{text("每月", "Monthly")}</SelectItem>
                <SelectItem value="week">{text("每周", "Weekly")}</SelectItem>
                <SelectItem value="day">{text("每天", "Daily")}</SelectItem>
                <SelectItem value="lifetime">{text("长期", "Lifetime")}</SelectItem>
                <SelectItem value="fixed">{text("固定时间", "Fixed dates")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {period === "fixed" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="field">
                <Label htmlFor="policy-quota-start">{text("开始", "Starts")}</Label>
                <Input
                  id="policy-quota-start"
                  type="datetime-local"
                  value={startsAt}
                  onChange={(event) => setStartsAt(event.target.value)}
                />
              </div>
              <div className="field">
                <Label htmlFor="policy-quota-end">{text("结束", "Ends")}</Label>
                <Input
                  id="policy-quota-end"
                  type="datetime-local"
                  value={endsAt}
                  onChange={(event) => setEndsAt(event.target.value)}
                />
              </div>
            </div>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={hardLimit}
              onCheckedChange={(checked) => setHardLimit(checked === true)}
            />
            {text("额度用完后停止模型调用", "Stop model calls when the allowance is used")}
          </label>
          <p className="text-xs text-muted-foreground">
            {hardLimit
              ? text(
                  "调用前会预留 AIU，余额不足时拒绝调用。",
                  "AIU is reserved before each call and calls are denied when insufficient.",
                )
              : text(
                  "超过额度只记录提醒，不会阻止调用。",
                  "Going over the allowance records a warning without blocking calls.",
                )}
          </p>
          {showPriority ? (
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button className="w-fit" size="sm" type="button" variant="ghost">
                  {text("高级选项", "Advanced")}
                  <ChevronDown />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="field rounded-lg border p-3">
                <Label htmlFor="policy-quota-priority">
                  {text("用户组优先级", "Group priority")}
                </Label>
                <Input
                  id="policy-quota-priority"
                  min="0"
                  max="10000"
                  step="1"
                  type="number"
                  value={priority}
                  onChange={(event) => setPriority(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {text(
                    "用户同时属于多个组时，数字较大的规则生效。",
                    "When a user is in multiple groups, the higher number wins.",
                  )}
                </p>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter showCloseButton>
          {policy !== null && onRemove !== undefined ? (
            <Button disabled={pending || removing} variant="destructive" onClick={onRemove}>
              {removing ? text("正在移除…", "Removing…") : text("移除规则", "Remove rule")}
            </Button>
          ) : null}
          <Button
            disabled={pending || removing || !valid}
            onClick={() =>
              onSubmit({
                limit,
                hard_limit: hardLimit,
                period,
                priority: priorityValue,
                ...(period === "fixed"
                  ? {
                      starts_at: new Date(startsAt).toISOString(),
                      ends_at: new Date(endsAt).toISOString(),
                    }
                  : {}),
              })
            }
          >
            {pending ? text("正在保存…", "Saving…") : text("保存", "Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

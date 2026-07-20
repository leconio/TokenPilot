"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import type { ApplicationUser } from "./types";

export function CreateUserDialog({
  open,
  pending,
  error,
  onOpenChange,
  onSubmit,
}: Readonly<{
  open: boolean;
  pending: boolean;
  error?: string | undefined;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: { user_id: string; display_user?: string }) => void;
}>) {
  const [userId, setUserId] = useState("");
  const [display, setDisplay] = useState("");
  useEffect(() => {
    if (!open) {
      setUserId("");
      setDisplay("");
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加用户</DialogTitle>
          <DialogDescription>用户 ID 必填，显示名称建议填写。</DialogDescription>
        </DialogHeader>
        <div className="form-grid">
          <div className="field">
            <Label htmlFor="new-user-id">用户 ID</Label>
            <Input
              id="new-user-id"
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
            />
          </div>
          <div className="field">
            <Label htmlFor="new-user-display">显示名称（推荐）</Label>
            <Input
              id="new-user-display"
              value={display}
              onChange={(event) => setDisplay(event.target.value)}
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter showCloseButton>
          <Button
            disabled={pending || userId.trim().length === 0}
            onClick={() =>
              onSubmit({
                user_id: userId.trim(),
                ...(display.trim() ? { display_user: display.trim() } : {}),
              })
            }
          >
            {pending ? "正在添加…" : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EditUserDialog({
  user,
  pending,
  error,
  onClose,
  onSubmit,
}: Readonly<{
  user: ApplicationUser | null;
  pending: boolean;
  error?: string | undefined;
  onClose: () => void;
  onSubmit: (input: { display_user: string | null; tags: readonly string[] }) => void;
}>) {
  const [display, setDisplay] = useState("");
  const [tags, setTags] = useState("");
  useEffect(() => {
    setDisplay(user?.display_user ?? "");
    setTags(user?.tags.join(", ") ?? "");
  }, [user]);
  return (
    <Dialog open={user !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑用户</DialogTitle>
          <DialogDescription>
            用户 ID 不可更改；显示名称也可以由后续模型调用更新。
          </DialogDescription>
        </DialogHeader>
        <div className="form-grid">
          <div className="field">
            <Label htmlFor="edit-user-id">用户 ID</Label>
            <Input id="edit-user-id" value={user?.user_id ?? ""} disabled />
          </div>
          <div className="field">
            <Label htmlFor="edit-user-tags">用户标签</Label>
            <Input
              id="edit-user-tags"
              placeholder="例如：付费用户, 内测"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">多个标签用逗号分隔。</p>
          </div>
          <div className="field">
            <Label htmlFor="edit-user-display">显示名称</Label>
            <Input
              id="edit-user-display"
              value={display}
              onChange={(event) => setDisplay(event.target.value)}
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter showCloseButton>
          <Button
            disabled={pending}
            onClick={() =>
              onSubmit({
                display_user: display.trim() || null,
                tags: [
                  ...new Set(
                    tags
                      .split(/[,，]/u)
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                  ),
                ],
              })
            }
          >
            {pending ? "正在保存…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function QuotaDialog({
  user,
  pending,
  error,
  onClose,
  onSubmit,
}: Readonly<{
  user: ApplicationUser | null;
  pending: boolean;
  error?: string | undefined;
  onClose: () => void;
  onSubmit: (input: {
    limit: string;
    hard_limit: boolean;
    period: string;
    starts_at?: string;
    ends_at?: string;
  }) => void;
}>) {
  const [limit, setLimit] = useState("");
  const [period, setPeriod] = useState("lifetime");
  const [hardLimit, setHardLimit] = useState(false);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  useEffect(() => {
    if (user === null) return;
    const micros = BigInt(user.quota.limit_aiu_micros);
    const whole = micros / 1_000_000n;
    const fraction = (micros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
    setLimit(`${whole}${fraction ? `.${fraction}` : ""}`);
    setPeriod(
      ["day", "week", "month", "fixed", "lifetime"].includes(user.quota.period)
        ? user.quota.period
        : "lifetime",
    );
    setHardLimit(user.quota.hard_limit);
    setStartsAt(user.quota.period_start?.slice(0, 16) ?? "");
    setEndsAt(user.quota.period_end?.slice(0, 16) ?? "");
  }, [user]);
  return (
    <Dialog open={user !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>设置 AIU 额度</DialogTitle>
          <DialogDescription>额度属于当前应用中的这个用户。</DialogDescription>
        </DialogHeader>
        <div className="form-grid">
          <div className="field">
            <Label htmlFor="quota-limit">额度</Label>
            <Input
              id="quota-limit"
              min="0"
              step="any"
              type="number"
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
            />
          </div>
          <div className="field">
            <Label htmlFor="quota-period">周期</Label>
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="w-full" id="quota-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="lifetime">长期</SelectItem>
                <SelectItem value="month">每月</SelectItem>
                <SelectItem value="week">每周</SelectItem>
                <SelectItem value="day">每天</SelectItem>
                <SelectItem value="fixed">固定时间</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {period === "fixed" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="field">
                <Label htmlFor="quota-start">开始</Label>
                <Input
                  id="quota-start"
                  type="datetime-local"
                  value={startsAt}
                  onChange={(event) => setStartsAt(event.target.value)}
                />
              </div>
              <div className="field">
                <Label htmlFor="quota-end">结束</Label>
                <Input
                  id="quota-end"
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
            额度用完后停止调用
          </label>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter showCloseButton>
          <Button
            disabled={
              pending ||
              !/^\d+(?:\.\d{1,6})?$/u.test(limit) ||
              (period === "fixed" && (!startsAt || !endsAt || startsAt >= endsAt))
            }
            onClick={() =>
              onSubmit({
                limit,
                hard_limit: hardLimit,
                period,
                ...(period === "fixed"
                  ? {
                      starts_at: new Date(startsAt).toISOString(),
                      ends_at: new Date(endsAt).toISOString(),
                    }
                  : {}),
              })
            }
          >
            {pending ? "正在保存…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReasonDialog({
  title,
  description,
  open,
  pending,
  error,
  destructive = false,
  onClose,
  onSubmit,
}: Readonly<{
  title: string;
  description: string;
  open: boolean;
  pending: boolean;
  error?: string | undefined;
  destructive?: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}>) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (!open) setReason("");
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="field">
          <Label htmlFor="user-action-reason">原因</Label>
          <Input
            id="user-action-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter showCloseButton>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={pending || reason.trim().length === 0}
            onClick={() => onSubmit(reason.trim())}
          >
            {pending ? "正在处理…" : "确认"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

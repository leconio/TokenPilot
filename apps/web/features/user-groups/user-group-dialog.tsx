"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
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
import type {
  UserGroupCondition,
  UserGroupDefinition,
  UserGroupField,
  UserGroupPreview,
} from "./types";

const fields: readonly { readonly value: UserGroupField; readonly label: string }[] = [
  { value: "user_id", label: "用户 ID" },
  { value: "display_user", label: "显示名称" },
  { value: "tag", label: "用户标签" },
  { value: "property", label: "用户属性" },
  { value: "status", label: "调用状态" },
  { value: "last_seen_at", label: "最近调用" },
  { value: "calls", label: "调用次数" },
  { value: "tokens", label: "Token" },
  { value: "aiu", label: "AIU" },
  { value: "cost", label: "模型花费" },
  { value: "remaining_aiu", label: "剩余 AIU" },
];

const operators = [
  ["equals", "等于"],
  ["not_equals", "不等于"],
  ["contains", "包含"],
  ["starts_with", "开头是"],
  ["one_of", "属于"],
  ["greater_than", "大于"],
  ["at_least", "大于等于"],
  ["less_than", "小于"],
  ["at_most", "小于等于"],
  ["is_set", "已设置"],
  ["is_not_set", "未设置"],
] as const;

const emptyCondition = (): UserGroupCondition => ({
  field: "tag",
  operator: "equals",
  value: "",
});

export function UserGroupDialog({
  open,
  pending,
  error,
  preview,
  previewPending,
  previewError,
  onOpenChange,
  onPreview,
  onSubmit,
}: Readonly<{
  open: boolean;
  pending: boolean;
  error?: string | undefined;
  preview?: UserGroupPreview | undefined;
  previewPending: boolean;
  previewError?: string | undefined;
  onOpenChange: (open: boolean) => void;
  onPreview: (definition: UserGroupDefinition) => void;
  onSubmit: (input: {
    name: string;
    description?: string;
    definition: UserGroupDefinition;
  }) => void;
}>) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [match, setMatch] = useState<"all" | "any">("all");
  const [conditions, setConditions] = useState<UserGroupCondition[]>([emptyCondition()]);
  useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
      setMatch("all");
      setConditions([emptyCondition()]);
    }
  }, [open]);

  function change(index: number, patch: Partial<UserGroupCondition>) {
    setConditions((current) =>
      current.map((condition, conditionIndex) =>
        conditionIndex === index ? { ...condition, ...patch } : condition,
      ),
    );
  }
  const valid =
    name.trim().length > 0 &&
    conditions.every(
      (condition) =>
        (condition.field !== "property" || Boolean(condition.property?.trim())) &&
        (["is_set", "is_not_set"].includes(condition.operator) || Boolean(condition.value?.trim())),
    );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>新建用户组</DialogTitle>
          <DialogDescription>组合用户条件，保存后可以用于筛选、分流和批量操作。</DialogDescription>
        </DialogHeader>
        <div className="form-grid">
          <div className="field">
            <Label htmlFor="group-name">名称</Label>
            <Input id="group-name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="field">
            <Label htmlFor="group-description">说明（可选）</Label>
            <Input
              id="group-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">满足</span>
            <Select value={match} onValueChange={(value) => setMatch(value as "all" | "any")}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部条件</SelectItem>
                <SelectItem value="any">任意条件</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            {conditions.map((condition, index) => (
              <div
                className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_1.3fr_auto]"
                key={index}
              >
                <Select
                  value={condition.field}
                  onValueChange={(value) => change(index, { field: value as UserGroupField })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {fields.map((field) => (
                      <SelectItem key={field.value} value={field.value}>
                        {field.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={condition.operator}
                  onValueChange={(value) => change(index, { operator: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {operators.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="grid gap-2">
                  {condition.field === "property" ? (
                    <Input
                      aria-label="属性标识"
                      placeholder="属性标识，例如 member_level"
                      value={condition.property ?? ""}
                      onChange={(event) => change(index, { property: event.target.value })}
                    />
                  ) : null}
                  {!["is_set", "is_not_set"].includes(condition.operator) ? (
                    <Input
                      aria-label="条件值"
                      placeholder="条件值"
                      value={condition.value ?? ""}
                      onChange={(event) => change(index, { value: event.target.value })}
                    />
                  ) : null}
                </div>
                <Button
                  aria-label="删除条件"
                  disabled={conditions.length === 1}
                  size="icon"
                  variant="ghost"
                  onClick={() =>
                    setConditions((current) => current.filter((_, item) => item !== index))
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
          <Button
            variant="outline"
            onClick={() => setConditions((current) => [...current, emptyCondition()])}
          >
            <Plus />
            添加条件
          </Button>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {previewError ? <p className="text-sm text-destructive">{previewError}</p> : null}
          {preview ? (
            <div className="rounded-md border p-3 text-sm">
              <strong>预计 {preview.member_count} 人</strong>
              {preview.sample_users.length > 0 ? (
                <p className="mt-1 text-muted-foreground">
                  示例：
                  {preview.sample_users.map((user) => user.display_user || user.user_id).join("、")}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter showCloseButton>
          <Button
            disabled={previewPending || !valid}
            variant="outline"
            onClick={() => onPreview({ match, conditions })}
          >
            {previewPending ? "正在计算…" : "预览人数"}
          </Button>
          <Button
            disabled={pending || !valid}
            onClick={() =>
              onSubmit({
                name: name.trim(),
                ...(description.trim() ? { description: description.trim() } : {}),
                definition: { match, conditions },
              })
            }
          >
            {pending ? "正在保存…" : "保存用户组"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

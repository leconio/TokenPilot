"use client";

import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
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

import type { ApplicationMember, ApplicationRoleName } from "./types";

const roleOptions: readonly { value: ApplicationRoleName; label: string }[] = [
  { value: "viewer", label: "只读成员" },
  { value: "analyst", label: "数据分析成员" },
  { value: "admin", label: "管理员" },
  { value: "owner", label: "所有者" },
];

const permissionOptions = [
  ["usage:read", "查看调用数据"],
  ["model:read", "查看模型"],
  ["model:write", "管理模型"],
  ["configuration:read", "查看分流配置"],
  ["configuration:write", "管理分流配置"],
  ["admin:read", "查看用户与应用设置"],
  ["admin:write", "管理用户与应用设置"],
  ["pricing:read", "查看模型花费与 AIU"],
  ["pricing:write", "管理模型花费与 AIU"],
  ["reports:read", "查看报表"],
  ["jobs:read", "查看后台任务"],
  ["jobs:write", "处理后台任务"],
  ["reconciliation:read", "查看数据核对"],
  ["reconciliation:write", "处理数据核对"],
] as const;

const readPermissions = [
  "usage:read",
  "model:read",
  "configuration:read",
  "admin:read",
  "pricing:read",
  "reports:read",
];

function defaultPermissions(role: ApplicationRoleName): string[] {
  if (role === "viewer") return [...readPermissions];
  if (role === "analyst") return [...readPermissions, "jobs:read", "reconciliation:read"];
  return permissionOptions.map(([permission]) => permission);
}

export function AddApplicationMemberDialog({
  open,
  pending,
  error,
  onOpenChange,
  onSubmit,
}: Readonly<{
  open: boolean;
  pending: boolean;
  error?: Error | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (email: string, role: ApplicationRoleName) => void;
}>) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ApplicationRoleName>("viewer");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加成员</DialogTitle>
          <DialogDescription>成员需要先使用这个邮箱登录过系统。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-2">
            <Label htmlFor="application-member-email">邮箱</Label>
            <Input
              id="application-member-email"
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              value={email}
            />
          </div>
          <RoleSelect id="new-member-role" role={role} onChange={setRole} />
        </div>
        <DialogError error={error} />
        <DialogFooter showCloseButton>
          <Button
            disabled={pending || !email.includes("@")}
            onClick={() => onSubmit(email.trim().toLowerCase(), role)}
          >
            {pending ? "正在添加…" : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EditApplicationMemberDialog({
  member,
  pending,
  error,
  onClose,
  onSubmit,
}: Readonly<{
  member: ApplicationMember;
  pending: boolean;
  error?: Error | null;
  onClose: () => void;
  onSubmit: (role: ApplicationRoleName, permissions: readonly string[]) => void;
}>) {
  const [role, setRole] = useState<ApplicationRoleName>(member.role);
  const [permissions, setPermissions] = useState<string[]>([...member.permissions]);
  function changeRole(next: ApplicationRoleName) {
    setRole(next);
    setPermissions(defaultPermissions(next));
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑成员</DialogTitle>
          <DialogDescription>
            {member.name} · {member.email}
          </DialogDescription>
        </DialogHeader>
        <RoleSelect id="edit-member-role" role={role} onChange={changeRole} />
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium">可用功能</legend>
          {permissionOptions.map(([permission, label]) => {
            const checked = permissions.includes(permission);
            return (
              <Label className="flex items-center gap-2 font-normal" key={permission}>
                <Checkbox
                  checked={checked}
                  disabled={role === "owner"}
                  onCheckedChange={(value) =>
                    setPermissions((current) =>
                      value === true
                        ? [...new Set([...current, permission])]
                        : current.filter((item) => item !== permission),
                    )
                  }
                />
                {label}
              </Label>
            );
          })}
        </fieldset>
        <DialogError error={error} />
        <DialogFooter showCloseButton>
          <Button disabled={pending} onClick={() => onSubmit(role, permissions)}>
            {pending ? "正在保存…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RemoveApplicationMemberDialog({
  member,
  pending,
  error,
  onClose,
  onConfirm,
}: Readonly<{
  member: ApplicationMember;
  pending: boolean;
  error?: Error | null;
  onClose: () => void;
  onConfirm: () => void;
}>) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>移除成员</DialogTitle>
          <DialogDescription>
            移除 {member.name} 后，这个账号将无法再查看当前应用。
          </DialogDescription>
        </DialogHeader>
        <DialogError error={error} />
        <DialogFooter showCloseButton>
          <Button disabled={pending} variant="destructive" onClick={onConfirm}>
            {pending ? "正在移除…" : "确认移除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RoleSelect({
  id,
  role,
  onChange,
}: Readonly<{
  id: string;
  role: ApplicationRoleName;
  onChange: (role: ApplicationRoleName) => void;
}>) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>角色</Label>
      <Select value={role} onValueChange={(value) => onChange(value as ApplicationRoleName)}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {roleOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function DialogError({ error }: Readonly<{ error?: Error | null | undefined }>) {
  return error ? (
    <Alert variant="destructive">
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  ) : null;
}

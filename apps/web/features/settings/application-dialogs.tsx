"use client";

import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { useLocale } from "@/i18n/locale-provider";

import type { ManagedApplication } from "./types";

export function CreateApplicationDialog({
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
  onSubmit: (name: string) => void;
}>) {
  const [name, setName] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建应用</DialogTitle>
          <DialogDescription>只填写团队能够识别的名称即可。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="managed-application-name">应用名称</Label>
          <Input
            autoFocus
            id="managed-application-name"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </div>
        <DialogError error={error} />
        <DialogFooter showCloseButton>
          <Button
            disabled={pending || name.trim().length === 0}
            onClick={() => onSubmit(name.trim())}
          >
            {pending ? "正在创建…" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EditApplicationDialog({
  application,
  pending,
  error,
  onClose,
  onSubmit,
}: Readonly<{
  application: ManagedApplication | null;
  pending: boolean;
  error?: Error | null;
  onClose: () => void;
  onSubmit: (value: { name: string; timezone: string; base_currency: string }) => void;
}>) {
  const [name, setName] = useState(application?.name ?? "");
  const [timezone, setTimezone] = useState(application?.timezone ?? "UTC");
  const [currency, setCurrency] = useState(application?.base_currency ?? "USD");
  return (
    <Dialog open={application !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑应用</DialogTitle>
          <DialogDescription>名称是日常使用唯一需要维护的字段。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="edit-application-name">应用名称</Label>
          <Input
            id="edit-application-name"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </div>
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button size="sm" variant="ghost">
              更多设置
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="grid gap-3 pt-3">
            <div className="grid gap-2">
              <Label htmlFor="edit-application-timezone">时区</Label>
              <Input
                id="edit-application-timezone"
                onChange={(event) => setTimezone(event.target.value)}
                value={timezone}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-application-currency">模型花费币种</Label>
              <Input
                id="edit-application-currency"
                maxLength={3}
                onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                value={currency}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
        <DialogError error={error} />
        <DialogFooter showCloseButton>
          <Button
            disabled={pending || name.trim().length === 0 || currency.length !== 3}
            onClick={() =>
              onSubmit({
                name: name.trim(),
                timezone: timezone.trim(),
                base_currency: currency,
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

export function ArchiveApplicationDialog({
  application,
  pending,
  error,
  onClose,
  onSubmit,
}: Readonly<{
  application: ManagedApplication | null;
  pending: boolean;
  error?: Error | null;
  onClose: () => void;
  onSubmit: (confirmationName: string, reason: string) => void;
}>) {
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  return (
    <Dialog open={application !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>归档应用</DialogTitle>
          <DialogDescription>
            这会停止应用，但不会删除事件、额度、报表或操作记录。输入完整应用名称并填写原因后继续。
          </DialogDescription>
        </DialogHeader>
        <Alert>
          <AlertDescription>需要输入：{application?.name}</AlertDescription>
        </Alert>
        <div className="grid gap-2">
          <Label htmlFor="archive-application-name">确认应用名称</Label>
          <Input
            id="archive-application-name"
            onChange={(event) => setConfirmation(event.target.value)}
            value={confirmation}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="archive-application-reason">归档原因</Label>
          <Textarea
            id="archive-application-reason"
            onChange={(event) => setReason(event.target.value)}
            value={reason}
          />
        </div>
        <DialogError error={error} />
        <DialogFooter showCloseButton>
          <Button
            disabled={pending || confirmation !== application?.name || reason.trim().length < 5}
            variant="destructive"
            onClick={() => onSubmit(confirmation, reason.trim())}
          >
            {pending ? "正在归档…" : "确认归档并保留历史"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ChangeApplicationStatusDialog({
  application,
  pending,
  error,
  onClose,
  onConfirm,
}: Readonly<{
  application: ManagedApplication;
  pending: boolean;
  error?: Error | null;
  onClose: () => void;
  onConfirm: () => void;
}>) {
  const { text } = useLocale();
  const enabling = application.status === "disabled";
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{enabling ? "启用应用" : "停用应用"}</DialogTitle>
          <DialogDescription>
            {enabling ? text("启用 ", "Enable ") : text("停用 ", "Disable ")}
            <span data-i18n-skip>{application.name}</span>
            {enabling
              ? text(" 后可继续接收和查看数据。", " to resume receiving and viewing data.")
              : text(
                  " 后会停止接入，但不会删除任何历史。",
                  ". New data will stop, but no history will be deleted.",
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogError error={error} />
        <DialogFooter showCloseButton>
          <Button
            disabled={pending}
            variant={enabling ? "default" : "destructive"}
            onClick={onConfirm}
          >
            {pending ? "正在保存…" : enabling ? "确认启用" : "确认停用"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DialogError({ error }: Readonly<{ error?: Error | null | undefined }>) {
  return error ? (
    <Alert variant="destructive">
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  ) : null;
}

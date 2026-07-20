"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AppWindow, Check, ChevronsUpDown, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
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
import { apiFetch } from "@/lib/api";

export interface SwitchableApplication {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
  readonly base_currency: string;
  readonly role: string;
  readonly status?: string;
  readonly permissions?: readonly string[];
}

const recentStorageKey = "tokenpilot.recent-applications";
const instanceQueryKeys = new Set(["applications", "session"]);

function readRecent(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(recentStorageKey) ?? "[]") as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function remember(slug: string): void {
  const next = [slug, ...readRecent().filter((item) => item !== slug)].slice(0, 5);
  window.localStorage.setItem(recentStorageKey, JSON.stringify(next));
}

export function ApplicationSwitcher({
  applications,
  current,
  className,
}: Readonly<{
  applications: readonly SwitchableApplication[];
  current: SwitchableApplication | undefined;
  className?: string;
}>) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => setRecent(readRecent()), []);
  useEffect(() => {
    if (current === undefined) return;
    remember(current.slug);
    setRecent(readRecent());
  }, [current]);
  const recentApplications = useMemo(
    () => recent.flatMap((slug) => applications.filter((item) => item.slug === slug)),
    [applications, recent],
  );

  async function clearApplicationState(): Promise<void> {
    const belongsToApplication = (query: { readonly queryKey: readonly unknown[] }) =>
      !instanceQueryKeys.has(String(query.queryKey[0] ?? ""));
    await queryClient.cancelQueries({ predicate: belongsToApplication });
    queryClient.removeQueries({ predicate: belongsToApplication });
  }

  const create = useMutation({
    mutationFn: () =>
      apiFetch<SwitchableApplication>("/applications", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      }),
    onSuccess: async (application) => {
      remember(application.slug);
      setCreating(false);
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["applications"] });
      await clearApplicationState();
      router.push(`/apps/${application.slug}/dashboard`);
    },
  });
  async function select(application: SwitchableApplication) {
    remember(application.slug);
    setOpen(false);
    await clearApplicationState();
    router.push(`/apps/${application.slug}/dashboard`);
  }

  return (
    <>
      <Button
        aria-label="切换应用"
        className={className}
        onClick={() => setOpen(true)}
        variant="outline"
      >
        <AppWindow />
        <span className="truncate" data-i18n-skip={current === undefined ? undefined : ""}>
          {current?.name ?? "选择应用"}
        </span>
        <ChevronsUpDown className="ml-auto opacity-60" />
      </Button>
      <CommandDialog
        description="搜索、切换或创建应用"
        onOpenChange={setOpen}
        open={open}
        showCloseButton
        title="切换应用"
      >
        <Command>
          <CommandInput aria-label="搜索应用" placeholder="搜索应用" />
          <CommandList>
            <CommandEmpty>没有匹配的应用。</CommandEmpty>
            {recentApplications.length > 0 ? (
              <CommandGroup heading="最近使用">
                {recentApplications.map((application) => (
                  <ApplicationOption
                    application={application}
                    current={current}
                    key={`recent-${application.id}`}
                    onSelect={select}
                  />
                ))}
              </CommandGroup>
            ) : null}
            <CommandGroup heading="全部应用">
              {applications.length === 0 ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">
                  当前账号还没有可访问的应用。
                </div>
              ) : (
                applications.map((application) => (
                  <ApplicationOption
                    application={application}
                    current={current}
                    key={application.id}
                    onSelect={select}
                  />
                ))
              )}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  setOpen(false);
                  setCreating(true);
                }}
              >
                <Plus />
                新建应用
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>创建应用</DialogTitle>
            <DialogDescription>只需填写用户能够识别的名称。</DialogDescription>
          </DialogHeader>
          <div className="field">
            <Label htmlFor="new-application-name">应用名称</Label>
            <Input
              autoFocus
              id="new-application-name"
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
            {create.error ? (
              <p className="text-sm text-destructive">{create.error.message}</p>
            ) : null}
          </div>
          <DialogFooter showCloseButton>
            <Button
              disabled={name.trim().length === 0 || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? "正在创建…" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ApplicationOption({
  application,
  current,
  onSelect,
}: Readonly<{
  application: SwitchableApplication;
  current: SwitchableApplication | undefined;
  onSelect: (application: SwitchableApplication) => void | Promise<void>;
}>) {
  return (
    <CommandItem
      value={`${application.name} ${application.slug}`}
      onSelect={() => void onSelect(application)}
    >
      <AppWindow />
      <span data-i18n-skip>{application.name}</span>
      {current?.id === application.id ? <Check className="ml-auto" /> : null}
    </CommandItem>
  );
}

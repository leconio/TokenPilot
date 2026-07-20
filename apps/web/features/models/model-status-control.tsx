"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Power } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLocale } from "@/i18n/locale-provider";
import { controlApi } from "@/lib/api";
import type { ModelDefinition, ModelDisableImpact } from "./types";

export function ModelStatusControl({
  applicationSlug,
  model,
}: Readonly<{ applicationSlug: string; model: ModelDefinition }>) {
  const [confirming, setConfirming] = useState(false);
  const { text } = useLocale();
  const client = useQueryClient();
  const path = `/applications/${applicationSlug}/models/${model.id}`;
  const impact = useQuery({
    queryKey: ["model-disable-impact", applicationSlug, model.id],
    queryFn: () => controlApi<ModelDisableImpact>(`${path}/disable-impact`),
    enabled: confirming && model.enabled,
  });
  const update = useMutation({
    mutationFn: (enabled: boolean) =>
      controlApi<ModelDefinition>(path, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: async () => {
      setConfirming(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["model", applicationSlug, model.id] }),
        client.invalidateQueries({ queryKey: ["models", applicationSlug] }),
      ]);
    },
  });

  if (!model.enabled) {
    return (
      <Button disabled={update.isPending} variant="outline" onClick={() => update.mutate(true)}>
        <Power /> {update.isPending ? "正在启用…" : "启用模型"}
      </Button>
    );
  }
  return (
    <>
      <Button variant="outline" onClick={() => setConfirming(true)}>
        <Power /> 停用模型
      </Button>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认停用模型？</DialogTitle>
            <DialogDescription>停用后，新调用不会再选择这个真实模型。</DialogDescription>
          </DialogHeader>
          {impact.isPending ? (
            <p className="text-sm text-muted-foreground">正在检查调用关系…</p>
          ) : impact.error ? (
            <p className="text-sm text-destructive">{impact.error.message}</p>
          ) : (impact.data?.virtual_models.length ?? 0) === 0 ? (
            <p className="text-sm">当前没有虚拟模型使用它。</p>
          ) : (
            <div className="grid gap-2">
              <p className="text-sm font-medium">
                {text(
                  `${impact.data?.reference_count} 个虚拟模型仍在使用它：`,
                  `${impact.data?.reference_count} virtual models still use it:`,
                )}
              </p>
              <ul className="list-inside list-disc text-sm text-muted-foreground">
                {impact.data?.virtual_models.map((reference) => (
                  <li data-i18n-skip key={reference.id}>
                    {reference.display_name}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {update.error ? <p className="text-sm text-destructive">{update.error.message}</p> : null}
          <DialogFooter showCloseButton>
            <Button
              disabled={impact.isPending || impact.error !== null || update.isPending}
              variant="destructive"
              onClick={() => update.mutate(false)}
            >
              {update.isPending ? "正在停用…" : "确认停用"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

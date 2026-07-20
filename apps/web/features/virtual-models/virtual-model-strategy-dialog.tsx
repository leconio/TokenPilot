"use client";

import { useMutation } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { controlApi } from "@/lib/api";
import { VirtualModelExtraTabs } from "./virtual-model-extra-tabs";
import { VirtualModelConditionTab } from "./virtual-model-condition-tab";
import { VirtualModelSimulationTab } from "./virtual-model-simulation-tab";
import type { ModelItem, VirtualModelItem, VirtualModelRule } from "./types";

const days = [
  [1, "周一"],
  [2, "周二"],
  [3, "周三"],
  [4, "周四"],
  [5, "周五"],
  [6, "周六"],
  [7, "周日"],
] as const;

function scheduleOf(rule: VirtualModelRule) {
  return "schedule" in rule.match ? rule.match.schedule : null;
}

export function VirtualModelStrategyDialog({
  model,
  models,
  path,
  onClose,
  onChanged,
}: Readonly<{
  model: VirtualModelItem | null;
  models: readonly ModelItem[];
  path: string;
  onClose: () => void;
  onChanged: (value: VirtualModelItem) => void;
}>) {
  const [candidateId, setCandidateId] = useState("");
  const [day, setDay] = useState("1");
  const [from, setFrom] = useState("09:00");
  const [to, setTo] = useState("18:00");
  const [ruleModelId, setRuleModelId] = useState("");
  const [overrideModelId, setOverrideModelId] = useState("");
  const [overrideHours, setOverrideHours] = useState("1");
  const modelPath = `${path}/${model?.id ?? "missing"}`;
  const apply = (value: VirtualModelItem) => onChanged(value);
  const addCandidate = useMutation({
    mutationFn: () =>
      controlApi<VirtualModelItem>(`${modelPath}/routes`, {
        method: "POST",
        body: JSON.stringify({ model_id: candidateId }),
      }),
    onSuccess: (value) => {
      setCandidateId("");
      apply(value);
    },
  });
  const updateModel = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      controlApi<VirtualModelItem>(modelPath, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: apply,
  });
  const reorder = useMutation({
    mutationFn: (ordered: readonly string[]) =>
      controlApi<VirtualModelItem>(`${modelPath}/routes/reorder`, {
        method: "POST",
        body: JSON.stringify({ ordered_target_ids: ordered }),
      }),
    onSuccess: apply,
  });
  const updateWeight = useMutation({
    mutationFn: ({ targetId, weight }: { targetId: string; weight: number }) =>
      controlApi<VirtualModelItem>(`${modelPath}/routes/${targetId}`, {
        method: "PATCH",
        body: JSON.stringify({ weight }),
      }),
    onSuccess: apply,
  });
  const addRule = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      controlApi<VirtualModelItem>(`${modelPath}/rules`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: apply,
  });
  const removeRule = useMutation({
    mutationFn: (ruleId: string) =>
      controlApi<VirtualModelItem>(`${modelPath}/rules/${ruleId}`, { method: "DELETE" }),
    onSuccess: apply,
  });
  useEffect(() => {
    const first = model?.targets[0]?.model.id ?? "";
    if (!model?.targets.some((target) => target.model.id === ruleModelId)) setRuleModelId(first);
    if (!model?.targets.some((target) => target.model.id === overrideModelId)) {
      setOverrideModelId(first);
    }
  }, [model, overrideModelId, ruleModelId]);
  if (model === null) return null;
  const currentModel = model;
  const available = models.filter(
    (candidate) =>
      candidate.enabled && !model.targets.some((target) => target.model.id === candidate.id),
  );
  const error =
    addCandidate.error ??
    updateModel.error ??
    reorder.error ??
    updateWeight.error ??
    addRule.error ??
    removeRule.error;
  function move(index: number, direction: -1 | 1) {
    const ordered = currentModel.targets.map((target) => target.id);
    const other = index + direction;
    if (other < 0 || other >= ordered.length) return;
    [ordered[index], ordered[other]] = [ordered[other]!, ordered[index]!];
    reorder.mutate(ordered);
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle data-i18n-skip>{model.display_name}</DialogTitle>
          <DialogDescription>
            在这个虚拟模型里维护默认模型、时段切换和调用失败后的尝试顺序。
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="strategy">
          <TabsList>
            <TabsTrigger value="strategy">默认与时段</TabsTrigger>
            <TabsTrigger value="conditions">条件分流</TabsTrigger>
            <TabsTrigger value="fallback">失败顺序</TabsTrigger>
            <TabsTrigger value="temporary">临时切换</TabsTrigger>
            <TabsTrigger value="test">测试</TabsTrigger>
          </TabsList>
          <TabsContent className="grid gap-4" value="strategy">
            <Card>
              <CardHeader>
                <CardTitle>默认模型</CardTitle>
                <CardDescription>没有时段条件命中时使用。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                <Select
                  value={model.default_model?.id ?? ""}
                  onValueChange={(default_model_id) => updateModel.mutate({ default_model_id })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择默认模型" />
                  </SelectTrigger>
                  <SelectContent>
                    {model.targets.map((target) => (
                      <SelectItem key={target.id} value={target.model.id}>
                        {target.model.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {available.length > 0 ? (
                  <div className="flex gap-2">
                    <Select value={candidateId} onValueChange={setCandidateId}>
                      <SelectTrigger>
                        <SelectValue placeholder="添加候选模型" />
                      </SelectTrigger>
                      <SelectContent>
                        {available.map((candidate) => (
                          <SelectItem key={candidate.id} value={candidate.id}>
                            <span data-i18n-skip>{candidate.name}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      disabled={!candidateId || addCandidate.isPending}
                      onClick={() => addCandidate.mutate()}
                    >
                      <Plus />
                      添加
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>高峰与低峰时段</CardTitle>
                <CardDescription>指定星期和时段改用另一模型，可添加多条。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                {model.rules
                  .filter((rule) => scheduleOf(rule) !== null)
                  .map((rule) => {
                    const schedule = scheduleOf(rule)!;
                    return (
                      <div
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3"
                        key={rule.id}
                      >
                        <span>
                          {days.find(([value]) => value === schedule.days[0])?.[1]} {schedule.from}-
                          {schedule.to} · {rule.target_model.name}
                        </span>
                        <Button
                          aria-label="删除时段"
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => removeRule.mutate(rule.id)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    );
                  })}
                {model.targets.length > 0 ? (
                  <div className="grid gap-2 sm:grid-cols-[110px_1fr_1fr_1.5fr_auto]">
                    <Select value={day} onValueChange={setDay}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {days.map(([value, label]) => (
                          <SelectItem key={value} value={String(value)}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      aria-label="开始时间"
                      type="time"
                      value={from}
                      onChange={(event) => setFrom(event.target.value)}
                    />
                    <Input
                      aria-label="结束时间"
                      type="time"
                      value={to}
                      onChange={(event) => setTo(event.target.value)}
                    />
                    <Select value={ruleModelId} onValueChange={setRuleModelId}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {model.targets.map((target) => (
                          <SelectItem key={target.id} value={target.model.id}>
                            {target.model.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      disabled={!ruleModelId || addRule.isPending}
                      onClick={() =>
                        addRule.mutate({
                          name: `时段 ${day} ${from}-${to}`,
                          target_model_id: ruleModelId,
                          match: { schedule: { days: [Number(day)], from, to } },
                        })
                      }
                    >
                      <Plus />
                      添加
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </TabsContent>
          <VirtualModelConditionTab
            model={model}
            path={path}
            pending={addRule.isPending}
            addRule={(body) => addRule.mutate(body)}
            removeRule={(ruleId) => removeRule.mutate(ruleId)}
          />
          <VirtualModelExtraTabs
            model={model}
            reorderPending={reorder.isPending}
            move={move}
            weightPending={updateWeight.isPending}
            updateWeight={(targetId, weight) => updateWeight.mutate({ targetId, weight })}
            overrideModelId={overrideModelId}
            setOverrideModelId={setOverrideModelId}
            overrideHours={overrideHours}
            setOverrideHours={setOverrideHours}
            addRulePending={addRule.isPending}
            addTemporaryRule={() =>
              addRule.mutate({
                name: "临时切换",
                priority: 10000,
                target_model_id: overrideModelId,
                match: { override_active: true },
                expires_at: new Date(Date.now() + Number(overrideHours) * 3_600_000).toISOString(),
              })
            }
            removeRule={(ruleId) => removeRule.mutate(ruleId)}
          />
          <VirtualModelSimulationTab modelPath={modelPath} />
        </Tabs>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter showCloseButton>
          <Button
            disabled={model.targets.length === 0 || updateModel.isPending}
            onClick={() => updateModel.mutate({ enabled: !model.enabled })}
          >
            {model.enabled ? "停用虚拟模型" : "启用虚拟模型"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

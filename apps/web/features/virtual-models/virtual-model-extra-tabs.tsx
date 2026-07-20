"use client";

import { ArrowDown, ArrowUp, Clock3, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TabsContent } from "@/components/ui/tabs";
import type { VirtualModelItem } from "./types";
import { VirtualModelTargetWeight } from "./virtual-model-target-weight";

export function VirtualModelExtraTabs({
  model,
  reorderPending,
  move,
  weightPending,
  updateWeight,
  overrideModelId,
  setOverrideModelId,
  overrideHours,
  setOverrideHours,
  addRulePending,
  addTemporaryRule,
  removeRule,
}: Readonly<{
  model: VirtualModelItem;
  reorderPending: boolean;
  move: (index: number, direction: -1 | 1) => void;
  weightPending: boolean;
  updateWeight: (targetId: string, weight: number) => void;
  overrideModelId: string;
  setOverrideModelId: (value: string) => void;
  overrideHours: string;
  setOverrideHours: (value: string) => void;
  addRulePending: boolean;
  addTemporaryRule: () => void;
  removeRule: (ruleId: string) => void;
}>) {
  return (
    <>
      <TabsContent value="fallback">
        <Card>
          <CardHeader>
            <CardTitle>调用失败后的尝试顺序</CardTitle>
            <CardDescription>
              当前模型失败时按顺序继续尝试；修改任一权重后，默认流量按权重选择首个模型。
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {model.targets.map((target, index) => (
              <div
                className="flex items-center justify-between rounded-xl border p-3"
                key={target.id}
              >
                <strong>
                  {index + 1}. {target.model.name}
                </strong>
                <div className="flex flex-wrap items-center gap-1">
                  <VirtualModelTargetWeight
                    pending={weightPending}
                    value={target.weight}
                    onSave={(weight) => updateWeight(target.id, weight)}
                  />
                  <Button
                    aria-label="上移"
                    size="icon-sm"
                    variant="outline"
                    disabled={index === 0 || reorderPending}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    aria-label="下移"
                    size="icon-sm"
                    variant="outline"
                    disabled={index === model.targets.length - 1 || reorderPending}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown />
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="temporary">
        <Card>
          <CardHeader>
            <CardTitle>临时切换</CardTitle>
            <CardDescription>故障或活动期间固定使用一个模型，到期自动恢复。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {model.rules
              .filter((rule) => "override_active" in rule.match)
              .map((rule) => (
                <div
                  className="flex items-center justify-between rounded-xl border p-3"
                  key={rule.id}
                >
                  <span>
                    {rule.target_model.name} · 到期{" "}
                    {rule.expires_at ? new Date(rule.expires_at).toLocaleString() : "未设置"}
                  </span>
                  <Button
                    aria-label="取消临时切换"
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => removeRule(rule.id)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            {model.targets.length > 0 ? (
              <div className="grid gap-2 sm:grid-cols-[1fr_8rem_auto]">
                <Select value={overrideModelId} onValueChange={setOverrideModelId}>
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
                <Select value={overrideHours} onValueChange={setOverrideHours}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 小时</SelectItem>
                    <SelectItem value="4">4 小时</SelectItem>
                    <SelectItem value="24">24 小时</SelectItem>
                  </SelectContent>
                </Select>
                <Button disabled={!overrideModelId || addRulePending} onClick={addTemporaryRule}>
                  <Clock3 />
                  立即切换
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </TabsContent>
    </>
  );
}

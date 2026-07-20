"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TabsContent } from "@/components/ui/tabs";
import { useLocale } from "@/i18n/locale-provider";
import { controlApi } from "@/lib/api";
import type { VirtualModelItem, VirtualModelRule } from "./types";

type ConditionType = "user" | "group" | "tag" | "property" | "aiu" | "source";

interface UserGroupOption {
  readonly id: string;
  readonly name: string;
  readonly member_count: number;
}

function isGeneralCondition(rule: VirtualModelRule): boolean {
  return !("schedule" in rule.match) && !("override_active" in rule.match);
}

function summary(
  rule: VirtualModelRule,
  groups: readonly UserGroupOption[],
  text: (chinese: string, english: string) => string,
): string {
  const match = rule.match;
  if ("user" in match) return `${text("用户", "User")} ${match.user.ids.join(", ")}`;
  if ("user_group" in match) {
    return `${text("用户组", "User group")} ${
      groups.find((group) => group.id === match.user_group.group_id)?.name ??
      text("已删除", "Deleted")
    }`;
  }
  if ("user_tag" in match) return `${text("标签", "Tag")} ${match.user_tag.value}`;
  if ("user_property" in match) {
    return `${text("用户属性", "User property")} ${match.user_property.key} ${match.user_property.operator} ${String(match.user_property.value ?? "")}`;
  }
  if ("aiu_state" in match) return `AIU ${text("状态", "status")} ${match.aiu_state.value}`;
  if ("call_source" in match)
    return `${text("调用来源", "Call source")} ${match.call_source.value}`;
  return text("条件", "Condition");
}

export function VirtualModelConditionTab({
  model,
  path,
  pending,
  addRule,
  removeRule,
}: Readonly<{
  model: VirtualModelItem;
  path: string;
  pending: boolean;
  addRule: (body: Record<string, unknown>) => void;
  removeRule: (ruleId: string) => void;
}>) {
  const { text } = useLocale();
  const [type, setType] = useState<ConditionType>("group");
  const [value, setValue] = useState("");
  const [propertyKey, setPropertyKey] = useState("");
  const [propertyOperator, setPropertyOperator] = useState("equals");
  const [targetModelId, setTargetModelId] = useState("");
  const groupsPath = path.replace(/\/virtual-models$/u, "/user-groups");
  const groups = useQuery({
    queryKey: ["application-user-groups", groupsPath],
    queryFn: () => controlApi<{ user_groups: readonly UserGroupOption[] }>(groupsPath),
  });
  const options = groups.data?.user_groups ?? [];
  useEffect(() => {
    if (!model.targets.some((target) => target.model.id === targetModelId)) {
      setTargetModelId(model.targets[0]?.model.id ?? "");
    }
  }, [model.targets, targetModelId]);

  function match(): Record<string, unknown> | null {
    const clean = value.trim();
    if (type === "group") return clean ? { user_group: { group_id: clean } } : null;
    if (type === "user") return clean ? { user: { ids: [clean] } } : null;
    if (type === "tag") return clean ? { user_tag: { value: clean } } : null;
    if (type === "aiu") return clean ? { aiu_state: { value: clean } } : null;
    if (type === "source") return clean ? { call_source: { value: clean } } : null;
    if (!propertyKey.trim()) return null;
    return {
      user_property: {
        key: propertyKey.trim(),
        operator: propertyOperator,
        ...(["is_set", "is_not_set"].includes(propertyOperator) ? {} : { value: clean }),
      },
    };
  }

  const candidate = match();
  return (
    <TabsContent value="conditions">
      <Card>
        <CardHeader>
          <CardTitle>条件分流</CardTitle>
          <CardDescription>
            可按用户、用户组、标签、用户资料、AIU 状态或调用来源选择模型。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {model.rules.filter(isGeneralCondition).map((rule) => (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3"
              key={rule.id}
            >
              <span data-i18n-skip>
                {summary(rule, options, text)} · {rule.target_model.name}
              </span>
              <Button
                aria-label="删除条件"
                size="icon-sm"
                variant="ghost"
                onClick={() => removeRule(rule.id)}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          {model.targets.length > 0 ? (
            <div className="grid gap-2 lg:grid-cols-[10rem_1fr_1fr_auto]">
              <Select
                value={type}
                onValueChange={(next) => {
                  setType(next as ConditionType);
                  setValue("");
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="group">用户组</SelectItem>
                  <SelectItem value="user">用户 ID</SelectItem>
                  <SelectItem value="tag">用户标签</SelectItem>
                  <SelectItem value="property">用户属性</SelectItem>
                  <SelectItem value="aiu">AIU 状态</SelectItem>
                  <SelectItem value="source">调用来源</SelectItem>
                </SelectContent>
              </Select>
              {type === "group" ? (
                <Select value={value} onValueChange={setValue}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择用户组" />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        <span data-i18n-skip>{group.name}</span> · {group.member_count}{" "}
                        {text("人", "people")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : type === "aiu" ? (
                <Select value={value} onValueChange={setValue}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择 AIU 状态" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="available">充足</SelectItem>
                    <SelectItem value="low">即将用完</SelectItem>
                    <SelectItem value="exhausted">已用完</SelectItem>
                    <SelectItem value="unlimited">未限制</SelectItem>
                  </SelectContent>
                </Select>
              ) : type === "property" ? (
                <div className="grid grid-cols-3 gap-2">
                  <Input
                    aria-label="用户属性标识"
                    placeholder="例如 member_level"
                    value={propertyKey}
                    onChange={(event) => setPropertyKey(event.target.value)}
                  />
                  <Select value={propertyOperator} onValueChange={setPropertyOperator}>
                    <SelectTrigger aria-label="比较方式">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="equals">等于</SelectItem>
                      <SelectItem value="not_equals">不等于</SelectItem>
                      <SelectItem value="contains">包含</SelectItem>
                      <SelectItem value="starts_with">开头是</SelectItem>
                      <SelectItem value="is_set">已设置</SelectItem>
                      <SelectItem value="is_not_set">未设置</SelectItem>
                    </SelectContent>
                  </Select>
                  {!["is_set", "is_not_set"].includes(propertyOperator) ? (
                    <Input
                      aria-label="用户属性值"
                      placeholder="例如 pro"
                      value={value}
                      onChange={(event) => setValue(event.target.value)}
                    />
                  ) : (
                    <div />
                  )}
                </div>
              ) : (
                <Input
                  placeholder={type === "source" ? "例如 voice" : "输入条件值"}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
              )}
              <Select value={targetModelId} onValueChange={setTargetModelId}>
                <SelectTrigger>
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent>
                  {model.targets.map((target) => (
                    <SelectItem key={target.id} value={target.model.id}>
                      <span data-i18n-skip>{target.model.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                disabled={candidate === null || !targetModelId || pending}
                onClick={() => {
                  if (candidate === null) return;
                  addRule({
                    name: `条件 ${type}`,
                    target_model_id: targetModelId,
                    match: candidate,
                  });
                }}
              >
                <Plus />
                添加
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </TabsContent>
  );
}

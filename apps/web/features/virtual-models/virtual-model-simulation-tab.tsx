"use client";

import { useMutation } from "@tanstack/react-query";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import type { SimulationResult } from "./types";

type PropertyType = "text" | "number" | "boolean";
interface PropertyInput {
  readonly id: number;
  readonly key: string;
  readonly type: PropertyType;
  readonly value: string;
}

function localInputValue(): string {
  const value = new Date();
  value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
  return value.toISOString().slice(0, 16);
}

function propertyValue(input: PropertyInput): string | number | boolean {
  if (input.type === "number") return Number(input.value);
  if (input.type === "boolean") return input.value === "true";
  return input.value;
}

export function VirtualModelSimulationTab({ modelPath }: Readonly<{ modelPath: string }>) {
  const { text } = useLocale();
  const [instant, setInstant] = useState(localInputValue);
  const [userId, setUserId] = useState("");
  const [callSource, setCallSource] = useState("");
  const [properties, setProperties] = useState<readonly PropertyInput[]>([]);
  const [nextPropertyId, setNextPropertyId] = useState(1);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const propertiesValid = properties.every(
    (property) =>
      property.key.trim().length > 0 &&
      property.value.length > 0 &&
      (property.type !== "number" || Number.isFinite(Number(property.value))),
  );
  const simulate = useMutation({
    mutationFn: () =>
      controlApi<SimulationResult>(modelPath + "/simulate", {
        method: "POST",
        body: JSON.stringify({
          instant: new Date(instant).toISOString(),
          ...(userId.trim() ? { user_id: userId.trim() } : {}),
          ...(callSource.trim() ? { call_source: callSource.trim() } : {}),
          ...(properties.length
            ? {
                user_properties: Object.fromEntries(
                  properties.map((property) => [property.key.trim(), propertyValue(property)]),
                ),
              }
            : {}),
        }),
      }),
    onSuccess: setResult,
  });
  function updateProperty(id: number, change: Partial<PropertyInput>) {
    setProperties((current) =>
      current.map((property) => (property.id === id ? { ...property, ...change } : property)),
    );
  }
  return (
    <TabsContent value="test">
      <Card>
        <CardHeader>
          <CardTitle>{text("策略测试", "Policy test")}</CardTitle>
          <CardDescription>
            {text(
              "选择时间；需要验证用户条件时，再填写用户和用户资料。",
              "Choose a time. Add a user and profile fields only when testing user conditions.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <Label className="sr-only" htmlFor="route-test-time">
              {text("调用时间", "Call time")}
            </Label>
            <Input
              id="route-test-time"
              type="datetime-local"
              value={instant}
              onChange={(event) => setInstant(event.target.value)}
            />
            <Button
              disabled={!instant || !propertiesValid || simulate.isPending}
              onClick={() => simulate.mutate()}
            >
              {simulate.isPending ? text("测试中…", "Testing…") : text("运行测试", "Run test")}
            </Button>
          </div>
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button className="w-fit" size="sm" variant="ghost">
                <ChevronDown />
                {text("添加用户条件（可选）", "Add user conditions (optional)")}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="grid gap-3 pt-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="route-test-user">{text("用户 ID", "User ID")}</Label>
                  <Input
                    id="route-test-user"
                    value={userId}
                    onChange={(event) => setUserId(event.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="route-test-source">{text("调用来源", "Call source")}</Label>
                  <Input
                    id="route-test-source"
                    value={callSource}
                    onChange={(event) => setCallSource(event.target.value)}
                  />
                </div>
              </div>
              {properties.map((property) => (
                <div className="grid gap-2 sm:grid-cols-[1fr_9rem_1fr_auto]" key={property.id}>
                  <Input
                    aria-label={text("用户资料字段名", "User profile field")}
                    placeholder={text("字段名", "Field name")}
                    value={property.key}
                    onChange={(event) => updateProperty(property.id, { key: event.target.value })}
                  />
                  <Select
                    value={property.type}
                    onValueChange={(type: PropertyType) =>
                      updateProperty(property.id, {
                        type,
                        value: type === "boolean" ? "true" : "",
                      })
                    }
                  >
                    <SelectTrigger aria-label={text("字段类型", "Field type")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="text">{text("文本", "Text")}</SelectItem>
                      <SelectItem value="number">{text("数字", "Number")}</SelectItem>
                      <SelectItem value="boolean">{text("是或否", "Yes or no")}</SelectItem>
                    </SelectContent>
                  </Select>
                  {property.type === "boolean" ? (
                    <Select
                      value={property.value}
                      onValueChange={(value) => updateProperty(property.id, { value })}
                    >
                      <SelectTrigger aria-label={text("字段值", "Field value")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="true">{text("是", "Yes")}</SelectItem>
                        <SelectItem value="false">{text("否", "No")}</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      aria-label={text("字段值", "Field value")}
                      inputMode={property.type === "number" ? "decimal" : "text"}
                      value={property.value}
                      onChange={(event) =>
                        updateProperty(property.id, { value: event.target.value })
                      }
                    />
                  )}
                  <Button
                    aria-label={text("删除用户资料条件", "Remove user profile condition")}
                    size="icon-sm"
                    variant="ghost"
                    onClick={() =>
                      setProperties((current) => current.filter((item) => item.id !== property.id))
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <Button
                className="w-fit"
                size="sm"
                variant="outline"
                onClick={() => {
                  setProperties((current) => [
                    ...current,
                    { id: nextPropertyId, key: "", type: "text", value: "" },
                  ]);
                  setNextPropertyId((value) => value + 1);
                }}
              >
                <Plus />
                {text("添加用户资料", "Add profile field")}
              </Button>
            </CollapsibleContent>
          </Collapsible>
          {simulate.error ? (
            <Alert variant="destructive">
              <AlertDescription>{simulate.error.message}</AlertDescription>
            </Alert>
          ) : null}
          {result ? (
            <div className="rounded-xl border p-4">
              <strong>
                {text("将调用 " + result.model.name, "Will call " + result.model.name)}
              </strong>
              <p className="text-sm text-muted-foreground">
                {result.matched_rule ?? text("默认规则", "Default rule")} ·{" "}
                {result.selection_mode === "weighted"
                  ? text("按权重选择", "Weighted selection")
                  : text("按顺序选择", "Ordered selection")}{" "}
                · {text("失败顺序", "Fallbacks")} {result.fallbacks.length} · {result.timezone}
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </TabsContent>
  );
}

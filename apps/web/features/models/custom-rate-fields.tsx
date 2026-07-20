"use client";

import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLocale } from "@/i18n/locale-provider";
import type { CustomRate } from "./types";

export function CustomRateFields({
  kind,
  values,
  onChange,
}: Readonly<{
  kind: "cost" | "aiu";
  values: readonly CustomRate[];
  onChange: (values: CustomRate[]) => void;
}>) {
  const { text } = useLocale();
  const update = (index: number, field: keyof CustomRate, value: string) => {
    onChange(
      values.map((item, itemIndex) => (itemIndex === index ? { ...item, [field]: value } : item)),
    );
  };
  return (
    <div className="field gap-3 md:col-span-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label>自定义单位</Label>
          <p className="text-xs text-muted-foreground">单位标识需与程序上报完全一致。</p>
        </div>
        <Button
          size="sm"
          type="button"
          variant="outline"
          onClick={() => onChange([...values, { unit_key: "", unit_size: "1", rate: "" }])}
        >
          <Plus /> 添加单位
        </Button>
      </div>
      {values.map((item, index) => (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_8rem_auto]" key={index}>
          <Input
            aria-label={text(`自定义单位 ${index + 1} 标识`, `Custom unit ${index + 1} key`)}
            placeholder="例如 tool_call"
            value={item.unit_key}
            onChange={(event) => update(index, "unit_key", event.target.value)}
          />
          <Input
            aria-label={text(
              `自定义单位 ${index + 1} 计价数量`,
              `Custom unit ${index + 1} pricing quantity`,
            )}
            inputMode="decimal"
            min="0"
            placeholder="每多少单位"
            step="any"
            type="number"
            value={item.unit_size}
            onChange={(event) => update(index, "unit_size", event.target.value)}
          />
          <Input
            aria-label={text(
              `自定义单位 ${index + 1} ${kind === "cost" ? "花费" : "AIU"}`,
              `Custom unit ${index + 1} ${kind === "cost" ? "cost" : "AIU"}`,
            )}
            inputMode="decimal"
            min="0"
            placeholder={kind === "cost" ? "花费" : "AIU"}
            step="any"
            type="number"
            value={item.rate}
            onChange={(event) => update(index, "rate", event.target.value)}
          />
          <Button
            aria-label={text(`删除自定义单位 ${index + 1}`, `Remove custom unit ${index + 1}`)}
            size="icon"
            type="button"
            variant="ghost"
            onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
    </div>
  );
}

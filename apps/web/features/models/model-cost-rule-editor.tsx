"use client";

import { ArrowDown, ArrowUp, ChevronDown, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { type ComboboxOption } from "@/components/ui/combobox";
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
import { newAnalysisCondition } from "@/features/control-plane/usage/analysis-condition";
import { AnalysisConditionRow } from "@/features/control-plane/usage/analysis-condition-row";
import { type AnalysisFieldDefinition } from "@/features/control-plane/usage/analysis-config";
import { useLocale } from "@/i18n/locale-provider";
import { costUsageAmounts, type EditableCostRule } from "./cost-rule-values";

function replace<T>(values: readonly T[], index: number, value: T): T[] {
  return values.map((item, itemIndex) => (itemIndex === index ? value : item));
}

function CostAmountInput({
  label,
  value,
  currency,
  onChange,
}: Readonly<{
  label: string;
  value: string;
  currency: string;
  onChange: (value: string) => void;
}>) {
  const { text } = useLocale();
  return (
    <div className="grid min-w-0 gap-2">
      <Label>{text(`${label}金额`, `${label} amount`)}</Label>
      <div className="relative">
        <Input
          className="pr-14"
          inputMode="decimal"
          min="0"
          placeholder="0"
          step="any"
          type="number"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
          {currency}
        </span>
      </div>
    </div>
  );
}

export function ModelCostRuleEditor({
  rule,
  index,
  count,
  currency,
  fields,
  options,
  onUpdate,
  onMove,
  onRemove,
}: Readonly<{
  rule: EditableCostRule;
  index: number;
  count: number;
  currency: string;
  fields: readonly AnalysisFieldDefinition[];
  options: Readonly<Record<string, readonly ComboboxOption[]>>;
  onUpdate: (patch: Partial<EditableCostRule>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}>) {
  const { text } = useLocale();
  return (
    <div className="grid gap-4 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-[12rem] flex-1 gap-2">
          <Label htmlFor={`${rule.clientId}-name`}>{text("规则名称", "Rule name")}</Label>
          <Input
            id={`${rule.clientId}-name`}
            maxLength={120}
            value={rule.name}
            onChange={(event) => onUpdate({ name: event.target.value })}
          />
        </div>
        <div className="flex gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={index === 0}
            aria-label={text("上移规则", "Move rule up")}
            onClick={() => onMove(-1)}
          >
            <ArrowUp />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={index === count - 1}
            aria-label={text("下移规则", "Move rule down")}
            onClick={() => onMove(1)}
          >
            <ArrowDown />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={text("删除规则", "Remove rule")}
            onClick={onRemove}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className="rounded-xl bg-muted/20 p-3">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span>{text("满足", "Match")}</span>
          <Select
            value={rule.match}
            onValueChange={(match) => onUpdate({ match: match as "all" | "any" })}
          >
            <SelectTrigger className="w-24" aria-label={text("条件关系", "Condition match")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{text("全部", "all")}</SelectItem>
              <SelectItem value="any">{text("任一", "any")}</SelectItem>
            </SelectContent>
          </Select>
          <span>{text("条件", "conditions")}</span>
        </div>
        <div className="grid gap-2">
          {rule.conditions.map((condition) => (
            <AnalysisConditionRow
              key={condition.id}
              condition={condition}
              fields={fields}
              options={options}
              onChange={(next) =>
                onUpdate({
                  conditions: rule.conditions.map((item) => (item.id === next.id ? next : item)),
                })
              }
              onRemove={() =>
                onUpdate({
                  conditions: rule.conditions.filter((item) => item.id !== condition.id),
                })
              }
            />
          ))}
          {rule.conditions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {text(
                "没有条件时，这是一条默认备用规则。",
                "With no conditions, this is the default fallback rule.",
              )}
            </p>
          ) : null}
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={fields.length === 0 || rule.conditions.length >= 32}
              onClick={() => {
                const first = fields[0];
                if (first)
                  onUpdate({ conditions: [...rule.conditions, newAnalysisCondition(first)] });
              }}
            >
              <Plus /> {text("添加条件", "Add condition")}
            </Button>
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <CostAmountInput
          label={text("每次调用固定", "Fixed request")}
          value={rule.fixedAmount}
          currency={currency}
          onChange={(fixedAmount) => onUpdate({ fixedAmount })}
        />
        {costUsageAmounts.slice(0, 2).map(({ usageType, label, labelEn }) => (
          <CostAmountInput
            key={usageType}
            label={text(`每个${label}`, `Each ${labelEn}`)}
            value={rule.amounts[usageType]}
            currency={currency}
            onChange={(amount) => onUpdate({ amounts: { ...rule.amounts, [usageType]: amount } })}
          />
        ))}
      </div>

      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button type="button" size="sm" variant="ghost">
            <ChevronDown /> {text("更多用量类型", "More usage types")}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="grid gap-3 pt-3 sm:grid-cols-2 xl:grid-cols-3">
          {costUsageAmounts.slice(2).map(({ usageType, label, labelEn }) => (
            <CostAmountInput
              key={usageType}
              label={text(`每个${label}`, `Each ${labelEn}`)}
              value={rule.amounts[usageType]}
              currency={currency}
              onChange={(amount) => onUpdate({ amounts: { ...rule.amounts, [usageType]: amount } })}
            />
          ))}
          <div className="grid gap-3 sm:col-span-2 xl:col-span-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label>{text("自定义用量", "Custom usage")}</Label>
                <p className="text-xs text-muted-foreground">
                  {text("标识需与程序上报一致。", "The key must match the reported usage key.")}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  onUpdate({
                    customAmounts: [...rule.customAmounts, { unit_key: "", amount_per_unit: "" }],
                  })
                }
              >
                <Plus /> {text("添加", "Add")}
              </Button>
            </div>
            {rule.customAmounts.map((amount, amountIndex) => (
              <div
                className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
                key={`${rule.clientId}-custom-${amountIndex}`}
              >
                <Input
                  aria-label={text("自定义用量标识", "Custom usage key")}
                  placeholder="tool_call"
                  value={amount.unit_key}
                  onChange={(event) =>
                    onUpdate({
                      customAmounts: replace(rule.customAmounts, amountIndex, {
                        ...amount,
                        unit_key: event.target.value,
                      }),
                    })
                  }
                />
                <Input
                  aria-label={text("自定义用量金额", "Custom usage amount")}
                  inputMode="decimal"
                  min="0"
                  placeholder="0"
                  step="any"
                  type="number"
                  value={amount.amount_per_unit}
                  onChange={(event) =>
                    onUpdate({
                      customAmounts: replace(rule.customAmounts, amountIndex, {
                        ...amount,
                        amount_per_unit: event.target.value,
                      }),
                    })
                  }
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={text("删除自定义用量", "Remove custom usage")}
                  onClick={() =>
                    onUpdate({
                      customAmounts: rule.customAmounts.filter(
                        (_, itemIndex) => itemIndex !== amountIndex,
                      ),
                    })
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

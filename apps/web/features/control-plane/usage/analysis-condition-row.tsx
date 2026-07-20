"use client";

import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { useLocale } from "@/i18n/locale-provider";
import { translateText } from "@/i18n/translator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  conditionFieldId,
  type AnalysisCondition,
  type AnalysisFieldDefinition,
  type AnalysisOperator,
  type AnalysisValue,
} from "./analysis-config";

const operatorLabels: Readonly<Record<AnalysisOperator, string>> = {
  equals: "等于",
  not_equals: "不等于",
  contains: "包含",
  starts_with: "开头是",
  greater_than: "大于",
  greater_or_equal: "大于等于",
  less_than: "小于",
  less_or_equal: "小于等于",
  between: "介于",
  one_of: "属于其中一个",
  contains_any: "包含任一项",
  contains_all: "包含全部项",
  is_set: "已填写",
  is_not_set: "未填写",
};

function valuesFromText(
  value: string,
  definition: AnalysisFieldDefinition,
): readonly AnalysisValue[] {
  if (value.trim().length === 0) return [];
  if (definition.data_type === "NUMBER") {
    const number = Number(value);
    return Number.isFinite(number) ? [number] : [];
  }
  if (definition.data_type === "DATETIME") {
    const instant = new Date(value);
    return Number.isFinite(instant.getTime()) ? [instant.toISOString()] : [];
  }
  return [value];
}

function singleValue(condition: AnalysisCondition): string {
  const value = condition.values[0];
  if (value === undefined) return "";
  if (condition.kind === "property" && condition.data_type === "DATETIME") {
    const instant = new Date(String(value));
    return Number.isFinite(instant.getTime()) ? instant.toISOString().slice(0, 16) : "";
  }
  return String(value);
}

function rangeValue(
  condition: AnalysisCondition,
  definition: AnalysisFieldDefinition,
  index: number,
): string {
  const value = condition.values[index];
  if (value === undefined) return "";
  if (definition.data_type !== "DATETIME") return String(value);
  const instant = new Date(String(value));
  return Number.isFinite(instant.getTime()) ? instant.toISOString().slice(0, 16) : "";
}

function optionsFor(
  definition: AnalysisFieldDefinition,
  dynamic: readonly ComboboxOption[],
): readonly ComboboxOption[] {
  return definition.allowed_values?.map((value) => ({ value, label: value })) ?? dynamic;
}

export function AnalysisConditionRow({
  condition,
  fields,
  options,
  onChange,
  onRemove,
}: Readonly<{
  condition: AnalysisCondition;
  fields: readonly AnalysisFieldDefinition[];
  options: Readonly<Record<string, readonly ComboboxOption[]>>;
  onChange: (condition: AnalysisCondition) => void;
  onRemove: () => void;
}>) {
  const { locale } = useLocale();
  const fieldId = conditionFieldId(condition);
  const definition = fields.find((field) => field.id === fieldId) ?? fields[0];
  if (definition === undefined) return null;
  const definitionLabel =
    definition.kind === "builtin" ? translateText(definition.label, locale) : definition.label;
  const valueLabel = locale === "en" ? `${definitionLabel} value` : `${definitionLabel}条件值`;
  const noValue = condition.operator === "is_set" || condition.operator === "is_not_set";
  const multiple = ["one_of", "contains_any", "contains_all"].includes(condition.operator);

  function replaceField(id: string) {
    const selected = fields.find((field) => field.id === id);
    if (selected === undefined) return;
    onChange(
      selected.kind === "builtin"
        ? {
            id: condition.id,
            kind: "builtin",
            field: selected.field!,
            operator: selected.operators[0] ?? "equals",
            values: [],
          }
        : {
            id: condition.id,
            kind: "property",
            scope: selected.scope!,
            key: selected.key!,
            data_type: selected.data_type,
            operator: selected.operators[0] ?? "equals",
            values: [],
          },
    );
  }

  function replaceOperator(operator: AnalysisOperator) {
    onChange({ ...condition, operator, values: [] } as AnalysisCondition);
  }

  function replaceValues(values: readonly AnalysisValue[]) {
    onChange({ ...condition, values } as AnalysisCondition);
  }

  const values = optionsFor(definition, options[fieldId] ?? []);
  return (
    <div className="grid min-w-0 gap-2 rounded-lg bg-background p-2 lg:grid-cols-[minmax(9rem,0.8fr)_minmax(8rem,0.6fr)_minmax(12rem,1.3fr)_auto] lg:items-center">
      <Select value={fieldId} onValueChange={replaceField}>
        <SelectTrigger className="w-full" aria-label="条件字段">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {fields.map((field) => (
            <SelectItem
              key={field.id}
              value={field.id}
              data-i18n-skip={field.kind === "property" ? true : undefined}
            >
              {field.kind === "builtin" ? translateText(field.label, locale) : field.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={condition.operator}
        onValueChange={(value) => replaceOperator(value as AnalysisOperator)}
      >
        <SelectTrigger className="w-full" aria-label="比较方式">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {definition.operators.map((operator) => (
            <SelectItem key={operator} value={operator}>
              {translateText(operatorLabels[operator], locale)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {noValue ? (
        <div className="flex h-8 items-center rounded-lg border bg-muted/30 px-2.5 text-sm text-muted-foreground">
          不需要填写值
        </div>
      ) : condition.operator === "between" ? (
        <div className="grid grid-cols-2 gap-2">
          {[0, 1].map((index) => (
            <Input
              key={index}
              type={definition.data_type === "DATETIME" ? "datetime-local" : "number"}
              aria-label={index === 0 ? "范围开始" : "范围结束"}
              value={rangeValue(condition, definition, index)}
              onChange={(event) => {
                const next = [...condition.values];
                const raw = event.target.value;
                if (raw === "") {
                  replaceValues([]);
                  return;
                }
                if (definition.data_type === "NUMBER") {
                  const parsed = Number(raw);
                  if (Number.isFinite(parsed)) next[index] = parsed;
                } else {
                  const instant = new Date(raw);
                  if (Number.isFinite(instant.getTime())) next[index] = instant.toISOString();
                }
                replaceValues(next);
              }}
            />
          ))}
        </div>
      ) : definition.data_type === "BOOLEAN" ? (
        <Select
          value={String(condition.values[0] ?? "")}
          onValueChange={(value) => replaceValues([value === "true"])}
        >
          <SelectTrigger className="w-full" aria-label={valueLabel}>
            <SelectValue placeholder="选择是或否" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">是</SelectItem>
            <SelectItem value="false">否</SelectItem>
          </SelectContent>
        </Select>
      ) : multiple ? (
        <Input
          value={condition.values.join(", ")}
          placeholder="多个值用逗号分隔"
          aria-label={valueLabel}
          onChange={(event) =>
            replaceValues(
              event.target.value
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
            )
          }
        />
      ) : values.length > 0 || definition.allow_custom_value ? (
        <Combobox
          value={singleValue(condition)}
          onValueChange={(value) => replaceValues(valuesFromText(value, definition))}
          options={values}
          placeholder={definition.placeholder}
          searchPlaceholder={definition.placeholder}
          allowCustomValue={definition.allow_custom_value ?? false}
          aria-label={valueLabel}
        />
      ) : (
        <Input
          type={
            definition.data_type === "DATETIME"
              ? "datetime-local"
              : definition.data_type === "NUMBER"
                ? "number"
                : "text"
          }
          value={singleValue(condition)}
          placeholder={definition.placeholder}
          aria-label={valueLabel}
          onChange={(event) => replaceValues(valuesFromText(event.target.value, definition))}
        />
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={
          locale === "en" ? `Remove ${definitionLabel} condition` : `删除${definitionLabel}条件`
        }
        onClick={onRemove}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

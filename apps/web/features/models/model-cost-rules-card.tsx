"use client";

import { Plus } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isAnalysisConditionComplete } from "@/features/control-plane/usage/analysis-condition";
import { conditionFieldId } from "@/features/control-plane/usage/analysis-config";
import {
  useAnalysisCatalog,
  useAnalysisOptions,
} from "@/features/control-plane/usage/analysis-options";
import { useLocale } from "@/i18n/locale-provider";
import { costRuleComplete, emptyCostRule, type EditableCostRule } from "./cost-rule-values";
import { ModelCostRuleEditor } from "./model-cost-rule-editor";

const supportedBuiltIns = new Set([
  "event_id",
  "request_id",
  "attempt_id",
  "operation_id",
  "session_id",
  "conversation_id",
  "user_id",
  "display_user",
  "application_version",
  "sdk_version",
  "connector_version",
  "config_version",
  "virtual_model",
  "model_id",
  "connection_id",
  "connection_driver",
  "request_model",
  "provider",
  "status",
  "schema_version",
  "route_reason",
  "latency_ms",
]);

function replace<T>(values: readonly T[], index: number, value: T): T[] {
  return values.map((item, itemIndex) => (itemIndex === index ? value : item));
}

export function ModelCostRulesCard({
  version,
  currency,
  values,
  saving,
  error,
  onChange,
  onSave,
}: Readonly<{
  version: number | null;
  currency: string;
  values: readonly EditableCostRule[];
  saving: boolean;
  error?: string | undefined;
  onChange: (values: EditableCostRule[]) => void;
  onSave: () => void;
}>) {
  const { text } = useLocale();
  const catalog = useAnalysisCatalog("cost");
  const fields = useMemo(
    () =>
      catalog.fields.filter(
        (field) => field.kind === "property" || supportedBuiltIns.has(field.field ?? ""),
      ),
    [catalog.fields],
  );
  const activeFields = useMemo(
    () => new Set(values.flatMap((rule) => rule.conditions.map(conditionFieldId))),
    [values],
  );
  const options = useAnalysisOptions(activeFields);
  const incomplete = values.some(
    (rule) =>
      !costRuleComplete(rule) ||
      rule.conditions.some((condition) => !isAnalysisConditionComplete(condition)),
  );

  function updateRule(index: number, patch: Partial<EditableCostRule>) {
    const rule = values[index];
    if (rule) onChange(replace(values, index, { ...rule, ...patch }));
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= values.length) return;
    const next = [...values];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  }

  return (
    <Card className="xl:col-span-2">
      <CardHeader>
        <CardTitle>{text("模型花费", "Model cost")}</CardTitle>
        <CardDescription>
          {text(
            "优先采用调用方上报的本次实际金额；未上报时，从上到下使用第一条匹配规则。这里不会影响 AIU。",
            "The reported amount is used first. When it is absent, the first matching rule below is used. AIU is not affected.",
          )}
        </CardDescription>
        {version === null ? null : (
          <span className="text-xs text-muted-foreground">
            {text(`规则版本 ${version}`, `Rule version ${version}`)}
          </span>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="rounded-xl border bg-muted/20 p-3 text-sm text-muted-foreground">
          {text(
            `上报金额无需配置，币种以调用记录为准。下列备用规则使用应用币种 ${currency}。`,
            `Reported amounts need no setup and retain their reported currency. Fallback rules use ${currency}.`,
          )}
        </div>
        {values.map((rule, index) => (
          <ModelCostRuleEditor
            key={rule.clientId}
            rule={rule}
            index={index}
            count={values.length}
            currency={currency}
            fields={fields}
            options={options}
            onUpdate={(patch) => updateRule(index, patch)}
            onMove={(direction) => move(index, direction)}
            onRemove={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
          />
        ))}
        {values.length === 0 ? (
          <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            {text(
              "没有备用规则时，只统计调用方上报的实际金额。",
              "Without fallback rules, only reported amounts are counted.",
            )}
          </div>
        ) : null}
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={values.length >= 64}
            onClick={() => onChange([...values, emptyCostRule(values.length)])}
          >
            <Plus /> {text("添加备用规则", "Add fallback rule")}
          </Button>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
      <CardFooter className="justify-end">
        <Button disabled={saving || incomplete} onClick={onSave}>
          {saving ? text("正在保存…", "Saving…") : text("保存花费规则", "Save cost rules")}
        </Button>
      </CardFooter>
    </Card>
  );
}

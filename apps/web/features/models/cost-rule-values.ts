import type {
  AnalysisCondition,
  AnalysisDataType,
} from "@/features/control-plane/usage/analysis-config";
import type { ModelCostRule } from "./types";

export const costUsageAmounts = [
  { usageType: "uncached_input_token", label: "输入 Token", labelEn: "input Token" },
  { usageType: "output_token", label: "输出 Token", labelEn: "output Token" },
  { usageType: "cache_read_input_token", label: "缓存读取 Token", labelEn: "cached-read Token" },
  { usageType: "cache_write_input_token", label: "缓存写入 Token", labelEn: "cached-write Token" },
  { usageType: "reasoning_output_token", label: "推理输出 Token", labelEn: "reasoning Token" },
  { usageType: "embedding_token", label: "向量输入 Token", labelEn: "embedding Token" },
  { usageType: "input_image", label: "输入图片", labelEn: "input image" },
  { usageType: "output_image", label: "输出图片", labelEn: "output image" },
  { usageType: "input_audio_second", label: "输入语音秒数", labelEn: "input audio second" },
  { usageType: "output_audio_second", label: "输出语音秒数", labelEn: "output audio second" },
  { usageType: "input_video_second", label: "输入视频秒数", labelEn: "input video second" },
  { usageType: "output_video_second", label: "输出视频秒数", labelEn: "output video second" },
  { usageType: "unknown", label: "其他用量", labelEn: "other usage unit" },
] as const;

export type CostUsageType = (typeof costUsageAmounts)[number]["usageType"];

export interface EditableCustomCostAmount {
  readonly unit_key: string;
  readonly amount_per_unit: string;
}

export interface EditableCostRule {
  readonly clientId: string;
  readonly name: string;
  readonly match: "all" | "any";
  readonly conditions: readonly AnalysisCondition[];
  readonly fixedAmount: string;
  readonly amounts: Readonly<Record<CostUsageType, string>>;
  readonly customAmounts: readonly EditableCustomCostAmount[];
}

function clientId(prefix = "cost-rule"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyAmounts(): Record<CostUsageType, string> {
  return Object.fromEntries(costUsageAmounts.map(({ usageType }) => [usageType, ""])) as Record<
    CostUsageType,
    string
  >;
}

export function emptyCostRule(index: number): EditableCostRule {
  return {
    clientId: clientId(),
    name: `规则 ${index + 1}`,
    match: "all",
    conditions: [],
    fixedAmount: "",
    amounts: emptyAmounts(),
    customAmounts: [],
  };
}

export function editableCostRules(rules: readonly ModelCostRule[] | undefined): EditableCostRule[] {
  return (rules ?? []).map((rule, ruleIndex) => {
    const amounts = emptyAmounts();
    const customAmounts: EditableCustomCostAmount[] = [];
    for (const rate of rule.rates) {
      if (rate.usage_type === "custom_unit" && rate.unit_key !== undefined) {
        customAmounts.push({
          unit_key: rate.unit_key,
          amount_per_unit: rate.amount_per_unit,
        });
      } else if (rate.usage_type in amounts) {
        amounts[rate.usage_type as CostUsageType] = rate.amount_per_unit;
      }
    }
    return {
      clientId: rule.id || `stored-cost-rule-${ruleIndex}`,
      name: rule.name,
      match: rule.match,
      conditions: rule.conditions.map((condition, conditionIndex) =>
        condition.kind === "builtin"
          ? ({
              id: `${rule.id}-condition-${conditionIndex}`,
              kind: "builtin",
              field: condition.field,
              operator: condition.operator,
              values: condition.values,
            } as AnalysisCondition)
          : ({
              id: `${rule.id}-condition-${conditionIndex}`,
              kind: "property",
              scope: condition.scope,
              key: condition.key,
              data_type: (condition.data_type ?? "TEXT") as AnalysisDataType,
              operator: condition.operator,
              values: condition.values,
            } as AnalysisCondition),
      ),
      fixedAmount: rule.fixed_amount ?? "",
      amounts,
      customAmounts,
    };
  });
}

export function costRulesRequestBody(rules: readonly EditableCostRule[]) {
  return {
    rules: rules.map((rule) => ({
      name: rule.name.trim(),
      match: rule.match,
      conditions: rule.conditions.map((condition) =>
        condition.kind === "builtin"
          ? {
              kind: "builtin" as const,
              field: condition.field,
              operator: condition.operator,
              values: condition.values,
            }
          : {
              kind: "property" as const,
              scope: condition.scope,
              key: condition.key,
              operator: condition.operator,
              values: condition.values,
            },
      ),
      fixed_amount: rule.fixedAmount === "" ? null : rule.fixedAmount,
      rates: [
        ...costUsageAmounts.flatMap(({ usageType }) =>
          rule.amounts[usageType] === ""
            ? []
            : [{ usage_type: usageType, amount_per_unit: rule.amounts[usageType] }],
        ),
        ...rule.customAmounts
          .filter((rate) => rate.unit_key.trim() !== "" && rate.amount_per_unit !== "")
          .map((rate) => ({
            usage_type: "custom_unit" as const,
            unit_key: rate.unit_key.trim(),
            amount_per_unit: rate.amount_per_unit,
          })),
      ],
    })),
  };
}

export function costRuleComplete(rule: EditableCostRule): boolean {
  const hasAmount =
    rule.fixedAmount !== "" ||
    Object.values(rule.amounts).some((amount) => amount !== "") ||
    rule.customAmounts.some(
      (amount) => amount.unit_key.trim() !== "" && amount.amount_per_unit !== "",
    );
  return rule.name.trim() !== "" && hasAmount;
}

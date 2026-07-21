import {
  modelCostConditionSchema,
  usageTypeValues,
  type ModelCostCondition,
  type NormalizedUsage,
} from "@tokenpilot/contracts";
import { Prisma } from "@tokenpilot/db";

const rateableUsageTypes = new Set<string>(usageTypeValues);

export interface ApplicationUsageLine {
  readonly usage_type: string;
  readonly unit_key?: string | undefined;
  readonly quantity: string;
}

type CostLine = CostRatingArtifact["lines"][number];

interface AiuDraft {
  readonly index: number;
  readonly line: ApplicationUsageLine;
  readonly unitKey: string;
  readonly rate: AiuRateItem | null;
  readonly raw: Prisma.Decimal | null;
  readonly floor: bigint;
  readonly fraction: Prisma.Decimal;
}

interface RateItem {
  readonly usageType: string;
  readonly unitKey: string;
  readonly unitSize: Prisma.Decimal;
}

interface CostRuleItem {
  readonly id: string;
  readonly usageType: string;
  readonly unitKey: string;
  readonly amountPerUnit: Prisma.Decimal;
}

interface CostRule {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly matchMode: string;
  readonly conditionsJson: unknown;
  readonly fixedAmount: Prisma.Decimal | null;
  readonly items: readonly CostRuleItem[];
}

interface AiuRateItem extends RateItem {
  readonly id: string;
  readonly aiuMicrosPerUnit: bigint;
}

function key(usageType: string, unitKey = ""): string {
  return `${usageType}\u0000${unitKey}`;
}

function relevant(line: ApplicationUsageLine): boolean {
  if (new Prisma.Decimal(line.quantity).isZero()) return false;
  return rateableUsageTypes.has(line.usage_type);
}

export interface CostRatingArtifact {
  readonly kind: "application_cost";
  readonly status: "official" | "unpriced";
  readonly source: "reported" | "reported_estimate" | "rule" | null;
  readonly versionId: string | null;
  readonly ruleId: string | null;
  readonly ruleName: string | null;
  readonly currency: string | null;
  readonly total: string | null;
  readonly lines: readonly {
    readonly usage_type: string | null;
    readonly unit_key: string;
    readonly quantity: string;
    readonly rate_item_id: string | null;
    readonly amount_per_unit: string | null;
    readonly amount: string | null;
  }[];
}

export interface AiuRatingArtifact {
  readonly kind: "application_aiu";
  readonly status: "official" | "unrated";
  readonly versionId: string | null;
  readonly totalMicros: bigint | null;
  readonly lines: readonly {
    readonly usage_type: string;
    readonly unit_key: string;
    readonly quantity: string;
    readonly rate_item_id: string | null;
    readonly raw_aiu_micros: string | null;
    readonly charged_aiu_micros: string | null;
  }[];
}

function isSet(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function equals(left: unknown, right: unknown): boolean {
  return typeof left === typeof right && left === right;
}

function comparison(value: unknown, condition: ModelCostCondition): boolean {
  if (condition.operator === "is_set") return isSet(value);
  if (condition.operator === "is_not_set") return !isSet(value);
  if (!isSet(value)) return false;
  if (condition.operator === "equals") return equals(value, condition.values[0]);
  if (condition.operator === "not_equals")
    return !condition.values.some((item) => equals(value, item));
  if (condition.operator === "one_of") return condition.values.some((item) => equals(value, item));
  if (condition.operator === "contains") {
    return typeof value === "string" && String(value).includes(String(condition.values[0]));
  }
  if (condition.operator === "starts_with") {
    return typeof value === "string" && String(value).startsWith(String(condition.values[0]));
  }
  if (condition.operator === "contains_any") {
    return Array.isArray(value) && condition.values.some((item) => value.includes(item));
  }
  if (condition.operator === "contains_all") {
    return Array.isArray(value) && condition.values.every((item) => value.includes(item));
  }
  if (condition.operator === "between") {
    const [from, to] = condition.values;
    if (typeof value === "number" && typeof from === "number" && typeof to === "number") {
      return value >= from && value <= to;
    }
    if (typeof value === "string" && typeof from === "string" && typeof to === "string") {
      return value >= from && value <= to;
    }
    return false;
  }
  const expected = condition.values[0];
  const order =
    typeof value === "number" && typeof expected === "number"
      ? value - expected
      : typeof value === "string" && typeof expected === "string"
        ? value.localeCompare(expected)
        : null;
  if (order === null) return false;
  if (condition.operator === "greater_than") return order > 0;
  if (condition.operator === "greater_or_equal") return order >= 0;
  if (condition.operator === "less_than") return order < 0;
  if (condition.operator === "less_or_equal") return order <= 0;
  return false;
}

function builtInValue(event: NormalizedUsage, field: string): unknown {
  const values: Readonly<Record<string, unknown>> = {
    event_id: event.event_id,
    request_id: event.request.request_id,
    attempt_id: event.request.attempt_id,
    operation_id: event.request.operation_id,
    session_id: event.request.session_id,
    conversation_id: event.request.conversation_id,
    user_id: event.user.user_id,
    display_user: event.user.display_user,
    application_version: event.application_version,
    sdk_version: event.sdk_version,
    connector_version: event.connector_version,
    config_version: event.config_version,
    virtual_model: event.model.virtual_model,
    model_id: event.model.model_id,
    connection_id: event.model.connection_id,
    connection_driver: event.model.connection_driver,
    request_model: event.model.request_model,
    provider: event.model.provider,
    status: event.result.status,
    schema_version: event.schema_version,
    route_reason: event.route?.reason,
    latency_ms: event.result.latency_ms,
  };
  return values[field];
}

export function matchesCostCondition(
  event: NormalizedUsage,
  condition: ModelCostCondition,
): boolean {
  const value =
    condition.kind === "builtin"
      ? builtInValue(event, condition.field)
      : condition.scope === "event"
        ? event.event_properties?.[condition.key]
        : event.user_properties?.[condition.key];
  return comparison(value, condition);
}

function matchingRule(rules: readonly CostRule[], event: NormalizedUsage): CostRule | null {
  for (const rule of [...rules].sort((left, right) => left.priority - right.priority)) {
    const parsed = modelCostConditionSchema.array().safeParse(rule.conditionsJson);
    if (!parsed.success) throw new TypeError(`Cost rule ${rule.id} has invalid conditions`);
    const matches = parsed.data.map((condition) => matchesCostCondition(event, condition));
    if (
      matches.length === 0 ||
      (rule.matchMode === "any" ? matches.some(Boolean) : matches.every(Boolean))
    ) {
      return rule;
    }
  }
  return null;
}

export function rateApplicationCost(
  version: {
    readonly id: string;
    readonly currency: string;
    readonly rules: readonly CostRule[];
  } | null,
  event: NormalizedUsage,
): CostRatingArtifact {
  if (event.source_cost !== null) {
    return {
      kind: "application_cost",
      status: "official",
      source: event.source_cost.is_estimated ? "reported_estimate" : "reported",
      versionId: null,
      ruleId: null,
      ruleName: null,
      currency: event.source_cost.currency,
      total: new Prisma.Decimal(event.source_cost.amount)
        .toDecimalPlaces(18, Prisma.Decimal.ROUND_HALF_UP)
        .toFixed(18),
      lines: [],
    };
  }
  const rule = version === null ? null : matchingRule(version.rules, event);
  if (version === null || rule === null) {
    return {
      kind: "application_cost",
      status: "unpriced",
      source: null,
      versionId: version?.id ?? null,
      ruleId: null,
      ruleName: null,
      currency: null,
      total: null,
      lines: [],
    };
  }
  const rates = new Map(rule.items.map((item) => [key(item.usageType, item.unitKey), item]));
  let total = rule.fixedAmount ?? new Prisma.Decimal(0);
  const lines: CostLine[] = [];
  if (rule.fixedAmount !== null) {
    lines.push({
      usage_type: null,
      unit_key: "",
      quantity: "1",
      rate_item_id: null,
      amount_per_unit: rule.fixedAmount.toFixed(18),
      amount: rule.fixedAmount.toFixed(18),
    });
  }
  for (const line of event.usage_lines) {
    if (!relevant(line)) continue;
    const unitKey = line.unit_key ?? "";
    const rate = rates.get(key(line.usage_type, unitKey));
    if (rate === undefined) continue;
    const amount = new Prisma.Decimal(line.quantity).mul(rate.amountPerUnit);
    total = total.add(amount);
    lines.push({
      usage_type: line.usage_type,
      unit_key: unitKey,
      quantity: line.quantity,
      rate_item_id: rate.id,
      amount_per_unit: rate.amountPerUnit.toFixed(18),
      amount: amount.toDecimalPlaces(18, Prisma.Decimal.ROUND_HALF_UP).toFixed(18),
    });
  }
  return {
    kind: "application_cost",
    status: "official",
    source: "rule",
    versionId: version.id,
    ruleId: rule.id,
    ruleName: rule.name,
    currency: version.currency,
    total: total.toDecimalPlaces(18, Prisma.Decimal.ROUND_HALF_UP).toFixed(18),
    lines,
  };
}

export function rateApplicationAiu(
  version: { readonly id: string; readonly items: readonly AiuRateItem[] } | null,
  usage: readonly ApplicationUsageLine[],
): AiuRatingArtifact {
  const rates = new Map(
    version?.items.map((item) => [key(item.usageType, item.unitKey), item]) ?? [],
  );
  let missing = version === null;
  const drafts: AiuDraft[] = [];
  for (const [index, line] of usage.entries()) {
    if (!relevant(line) || line.usage_type === "request") continue;
    const unitKey = line.unit_key ?? "";
    const rate = rates.get(key(line.usage_type, unitKey));
    if (rate === undefined) {
      missing = true;
      drafts.push({
        index,
        line,
        unitKey,
        rate: null,
        raw: null,
        floor: 0n,
        fraction: new Prisma.Decimal(0),
      });
      continue;
    }
    const raw = new Prisma.Decimal(line.quantity)
      .div(rate.unitSize)
      .mul(rate.aiuMicrosPerUnit.toString());
    const floor = BigInt(raw.floor().toFixed(0));
    drafts.push({ index, line, unitKey, rate, raw, floor, fraction: raw.minus(raw.floor()) });
  }
  if (missing) {
    return {
      kind: "application_aiu",
      status: "unrated",
      versionId: version?.id ?? null,
      totalMicros: null,
      lines: drafts.map((draft) => ({
        usage_type: draft.line.usage_type,
        unit_key: draft.unitKey,
        quantity: draft.line.quantity,
        rate_item_id: draft.rate?.id ?? null,
        raw_aiu_micros: draft.raw?.toFixed(18) ?? null,
        charged_aiu_micros: null,
      })),
    };
  }
  const rawTotal = drafts.reduce((sum, draft) => sum.add(draft.raw ?? 0), new Prisma.Decimal(0));
  const target = BigInt(rawTotal.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
  const floors = drafts.reduce((sum, draft) => sum + draft.floor, 0n);
  let additions = target - floors;
  const selected = new Set(
    [...drafts]
      .sort((left, right) => right.fraction.comparedTo(left.fraction) || left.index - right.index)
      .flatMap((draft) => {
        if (additions <= 0n) return [];
        additions -= 1n;
        return [draft.index];
      }),
  );
  return {
    kind: "application_aiu",
    status: "official",
    versionId: version!.id,
    totalMicros: target,
    lines: drafts.map((draft) => ({
      usage_type: draft.line.usage_type,
      unit_key: draft.unitKey,
      quantity: draft.line.quantity,
      rate_item_id: draft.rate!.id,
      raw_aiu_micros: draft.raw!.toFixed(18),
      charged_aiu_micros: (draft.floor + (selected.has(draft.index) ? 1n : 0n)).toString(),
    })),
  };
}

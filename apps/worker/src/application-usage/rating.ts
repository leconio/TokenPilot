import { usageTypeValues } from "@tokenpilot/contracts";
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

interface CostRateItem extends RateItem {
  readonly id: string;
  readonly unitPrice: Prisma.Decimal;
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
  readonly versionId: string | null;
  readonly currency: string | null;
  readonly total: string | null;
  readonly lines: readonly {
    readonly usage_type: string;
    readonly unit_key: string;
    readonly quantity: string;
    readonly rate_item_id: string | null;
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

export function rateApplicationCost(
  version: {
    readonly id: string;
    readonly currency: string;
    readonly items: readonly CostRateItem[];
  } | null,
  usage: readonly ApplicationUsageLine[],
): CostRatingArtifact {
  const rates = new Map(
    version?.items.map((item) => [key(item.usageType, item.unitKey), item]) ?? [],
  );
  let missing = version === null;
  let total = new Prisma.Decimal(0);
  const lines: CostLine[] = [];
  for (const line of usage) {
    if (!relevant(line)) continue;
    const unitKey = line.unit_key ?? "";
    const rate = rates.get(key(line.usage_type, unitKey));
    if (rate === undefined) {
      missing = true;
      lines.push({
        usage_type: line.usage_type,
        unit_key: unitKey,
        quantity: line.quantity,
        rate_item_id: null,
        amount: null,
      });
      continue;
    }
    const amount = new Prisma.Decimal(line.quantity).div(rate.unitSize).mul(rate.unitPrice);
    total = total.add(amount);
    lines.push({
      usage_type: line.usage_type,
      unit_key: unitKey,
      quantity: line.quantity,
      rate_item_id: rate.id,
      amount: amount.toDecimalPlaces(18, Prisma.Decimal.ROUND_HALF_UP).toFixed(18),
    });
  }
  return {
    kind: "application_cost",
    status: missing ? "unpriced" : "official",
    versionId: version?.id ?? null,
    currency: missing ? null : (version?.currency ?? null),
    total: missing ? null : total.toDecimalPlaces(18, Prisma.Decimal.ROUND_HALF_UP).toFixed(18),
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

import { Prisma } from "@tokenpilot/db";

function decimal(value: Prisma.Decimal | null | undefined): string {
  if (value === null || value === undefined) return "0";
  const text = value.toFixed();
  return text.includes(".") ? text.replace(/0+$/u, "").replace(/\.$/u, "") : text;
}

export interface ModelReferenceRow {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly defaultModelId: string | null;
  readonly targets: readonly { readonly id: string }[];
  readonly rules: readonly { readonly id: string }[];
}

export function presentModelReferences(modelId: string, rows: readonly ModelReferenceRow[]) {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    display_name: row.displayName,
    enabled: row.enabled,
    uses_as: [
      ...(row.defaultModelId === modelId ? (["default"] as const) : []),
      ...(row.targets.length > 0 ? (["candidate"] as const) : []),
      ...(row.rules.length > 0 ? (["rule"] as const) : []),
    ],
  }));
}

export function presentModelMetrics(
  aggregate: {
    readonly _count: { readonly _all: number };
    readonly _sum: {
      readonly totalTokens: Prisma.Decimal | null;
      readonly providerCost: Prisma.Decimal | null;
      readonly aiuMicros: bigint | null;
    };
  },
  currency: string,
) {
  const aiuMicros = aggregate._sum.aiuMicros ?? 0n;
  return {
    calls: aggregate._count._all,
    tokens: decimal(aggregate._sum.totalTokens),
    cost: decimal(aggregate._sum.providerCost),
    currency,
    aiu: decimal(new Prisma.Decimal(aiuMicros.toString()).div(1_000_000)),
    aiu_micros: aiuMicros.toString(),
  };
}

export interface UnresolvedIssueRow {
  readonly eventId: string;
  readonly eventTime: Date;
  readonly lastError: string | null;
}

export interface RatingIssueRow {
  readonly eventId: string;
  readonly ratedAt: Date;
  readonly costStatus: string;
  readonly aiuStatus: string;
}

export function presentModelIssues(
  unresolved: readonly UnresolvedIssueRow[],
  ratings: readonly RatingIssueRow[],
) {
  return [
    ...unresolved.map((row) => ({
      event_id: row.eventId,
      occurred_at: row.eventTime.toISOString(),
      types: ["unresolved"] as const,
      detail: row.lastError,
    })),
    ...ratings.map((row) => ({
      event_id: row.eventId,
      occurred_at: row.ratedAt.toISOString(),
      types: [
        ...(row.costStatus === "unpriced" ? (["unpriced"] as const) : []),
        ...(row.aiuStatus === "unrated" ? (["unrated"] as const) : []),
      ],
      detail: null,
    })),
  ]
    .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at))
    .slice(0, 8);
}

import type { ReplayPlan, ReplayType } from "./types.js";

function date(value: string, field: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${field} is invalid`);
  return parsed;
}

function coveredByIntervals(
  rangeStart: Date,
  rangeEnd: Date,
  intervals: readonly { readonly start: string; readonly end: string | null }[],
): boolean {
  return intervals.some((interval) => {
    const start = date(interval.start, "AIU enabled interval start");
    const end =
      interval.end === null
        ? new Date(8_640_000_000_000_000)
        : date(interval.end, "AIU enabled interval end");
    return start <= rangeStart && end >= rangeEnd;
  });
}

export function planReplay(input: {
  readonly replayType: ReplayType;
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly dryRun?: boolean;
  readonly reason?: string;
  readonly requestedBy?: string;
  readonly existingProviderCostLedgerEffects?: boolean;
  readonly existingAiuLedgerEffects?: boolean;
  readonly wouldCreateAiuLedger?: boolean;
  readonly aiuEnabledIntervals?: readonly { readonly start: string; readonly end: string | null }[];
}): ReplayPlan {
  const start = date(input.rangeStart, "rangeStart");
  const end = date(input.rangeEnd, "rangeEnd");
  if (end <= start) throw new TypeError("replay rangeEnd must follow rangeStart");
  const dryRun = input.dryRun ?? true;
  if (!dryRun) {
    if (input.reason === undefined || input.reason.trim().length < 5 || input.reason.length > 500) {
      throw new TypeError("committed replay requires a reason between 5 and 500 characters");
    }
    if (input.requestedBy === undefined || input.requestedBy.trim().length === 0) {
      throw new TypeError("committed replay requires an audit actor");
    }
  }
  const aiuCoverage = coveredByIntervals(start, end, input.aiuEnabledIntervals ?? []);
  if (input.wouldCreateAiuLedger === true && !aiuCoverage) {
    throw new TypeError(
      "ordinary replay cannot charge historical intervals where AIU was not enabled",
    );
  }
  return {
    replayType: input.replayType,
    rangeStart: start.toISOString(),
    rangeEnd: end.toISOString(),
    dryRun,
    reason: dryRun ? null : input.reason!.trim(),
    requestedBy: dryRun ? null : input.requestedBy!,
    providerCostCorrection:
      input.replayType === "rerun_provider_cost" && input.existingProviderCostLedgerEffects === true
        ? "replacement_and_reversal"
        : "none",
    aiuCorrection:
      input.replayType === "rerun_aiu_observe" && input.existingAiuLedgerEffects === true
        ? "ledger_adjustment"
        : "none",
    historicalAiuChargeAllowed: input.wouldCreateAiuLedger === true && aiuCoverage,
  };
}

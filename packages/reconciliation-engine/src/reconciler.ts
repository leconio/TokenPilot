import { Decimal } from "decimal.js";

import {
  parseCost,
  parseMetricInteger,
  signedCostDelta,
  signedIntegerDelta,
  usageMetricKeys,
  validateMetrics,
} from "./metrics.js";

import type {
  ReconciliationDiff,
  ReconciliationDiffType,
  ReconciliationDimensions,
  ReconciliationMetrics,
  ReconciliationSeverity,
  ReconciliationSnapshotRow,
  ReconciliationTolerance,
} from "./types.js";

const severity: Readonly<Record<ReconciliationDiffType, ReconciliationSeverity>> = {
  CH_MISSING: "error",
  PG_MISSING: "warning",
  DUPLICATE_PROJECTION: "error",
  PAYLOAD_HASH_CONFLICT: "critical",
  USAGE_NORMALIZATION_MISMATCH: "error",
  MODEL_IDENTITY_MISMATCH: "error",
  PRICE_VERSION_MISMATCH: "error",
  AIU_RATE_VERSION_MISMATCH: "error",
  PROVISIONAL_OFFICIAL_DELTA_PENDING: "warning",
  LEDGER_PROJECTION_MISSING: "critical",
  LATE_EVENT: "info",
  ADJUSTMENT_NOT_PROJECTED: "critical",
  WATERMARK_STALLED: "critical",
};

function dimensionsKey(value: ReconciliationDimensions): string {
  return JSON.stringify([
    value.bucketSize,
    value.bucketStart,
    value.applicationId,
    value.virtualModel,
    value.modelId,
    value.requestModel,
    value.provider,
    value.userId,
  ]);
}

function samples(...groups: readonly (readonly string[])[]): readonly string[] {
  return [...new Set(groups.flat())].sort().slice(0, 100);
}

function countDelta(pg: ReconciliationMetrics | null, ch: ReconciliationMetrics | null): string {
  const left = pg === null ? 0n : parseMetricInteger(pg.eventCount, "pg.eventCount");
  const right = ch === null ? 0n : parseMetricInteger(ch.eventCount, "ch.eventCount");
  const delta = left - right;
  return (delta < 0n ? -delta : delta).toString();
}

function diff(input: {
  readonly type: ReconciliationDiffType;
  readonly dimensions: ReconciliationDimensions | null;
  readonly pg: ReconciliationSnapshotRow | null;
  readonly ch: ReconciliationSnapshotRow | null;
  readonly deltaValues?: Partial<ReconciliationMetrics>;
  readonly count?: string;
  readonly amount?: string | null;
  readonly explanation: string;
}): ReconciliationDiff {
  return {
    type: input.type,
    severity: severity[input.type],
    dimensions: input.dimensions,
    count: input.count ?? countDelta(input.pg?.metrics ?? null, input.ch?.metrics ?? null),
    amount: input.amount ?? null,
    pgValues: input.pg?.metrics ?? null,
    chValues: input.ch?.metrics ?? null,
    deltaValues: input.deltaValues ?? {},
    sampleEventIds: samples(input.pg?.sampleEventIds ?? [], input.ch?.sampleEventIds ?? []),
    explanation: input.explanation,
  };
}

function group(
  rows: readonly ReconciliationSnapshotRow[],
): Map<string, ReconciliationSnapshotRow[]> {
  const grouped = new Map<string, ReconciliationSnapshotRow[]>();
  for (const row of rows) {
    validateMetrics(row.metrics);
    const duplicateProjectionCount = parseMetricInteger(
      row.duplicateProjectionCount ?? "0",
      "duplicateProjectionCount",
    );
    if (duplicateProjectionCount < 0n)
      throw new TypeError("duplicateProjectionCount cannot be negative");
    if (!Number.isFinite(Date.parse(row.dimensions.bucketStart))) {
      throw new TypeError("reconciliation bucketStart is invalid");
    }
    const key = dimensionsKey(row.dimensions);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return grouped;
}

function pairedDiffs(
  pg: ReconciliationSnapshotRow,
  ch: ReconciliationSnapshotRow,
  tolerance: ReconciliationTolerance,
): readonly ReconciliationDiff[] {
  const output: ReconciliationDiff[] = [];
  const dimensions = pg.dimensions;
  if (pg.payloadHashConflict || ch.payloadHashConflict) {
    output.push(
      diff({
        type: "PAYLOAD_HASH_CONFLICT",
        dimensions,
        pg,
        ch,
        count: "1",
        explanation: "the same event id was observed with different canonical payload hashes",
      }),
    );
  }
  if (pg.modelIdentityFingerprint !== ch.modelIdentityFingerprint) {
    output.push(
      diff({
        type: "MODEL_IDENTITY_MISMATCH",
        dimensions,
        pg,
        ch,
        count: "1",
        explanation: "model identity differs between official and projected data",
      }),
    );
  }
  if (pg.costVersionId !== ch.costVersionId) {
    output.push(
      diff({
        type: "PRICE_VERSION_MISMATCH",
        dimensions,
        pg,
        ch,
        count: "1",
        explanation: "provider price version differs between official and projected data",
      }),
    );
  }
  if (pg.aiuVersionId !== ch.aiuVersionId) {
    output.push(
      diff({
        type: "AIU_RATE_VERSION_MISMATCH",
        dimensions,
        pg,
        ch,
        count: "1",
        explanation: "AIU rate-card version differs between official and projected data",
      }),
    );
  }

  const usageDelta: { -readonly [Key in keyof ReconciliationMetrics]?: string } = {};
  for (const key of usageMetricKeys) {
    if (pg.metrics[key] !== ch.metrics[key])
      usageDelta[key] = signedIntegerDelta(pg.metrics[key], ch.metrics[key]);
  }
  if (Object.keys(usageDelta).length > 0) {
    output.push(
      diff({
        type: "USAGE_NORMALIZATION_MISMATCH",
        dimensions,
        pg,
        ch,
        deltaValues: usageDelta,
        explanation: "normalized counts or mutually-exclusive usage buckets differ",
      }),
    );
  }

  const costDelta = parseCost(pg.metrics.providerCost, "pg.providerCost").minus(
    parseCost(ch.metrics.providerCost, "ch.providerCost"),
  );
  const costTolerance = new Decimal(tolerance.providerCost);
  if (!costTolerance.isFinite() || costTolerance.isNegative())
    throw new TypeError("providerCost tolerance is invalid");
  if (costDelta.abs().gt(costTolerance)) {
    output.push(
      diff({
        type:
          pg.officialDeltaPending || ch.officialDeltaPending
            ? "PROVISIONAL_OFFICIAL_DELTA_PENDING"
            : "LEDGER_PROJECTION_MISSING",
        dimensions,
        pg,
        ch,
        deltaValues: {
          providerCost: signedCostDelta(pg.metrics.providerCost, ch.metrics.providerCost),
        },
        amount: costDelta.abs().toFixed(18),
        explanation:
          pg.officialDeltaPending || ch.officialDeltaPending
            ? "official provider-cost delta is queued but not yet reflected in ClickHouse"
            : "official provider-cost ledger total is not reflected in ClickHouse",
      }),
    );
  }

  const aiuDelta =
    parseMetricInteger(pg.metrics.aiuMicros, "pg.aiuMicros") -
    parseMetricInteger(ch.metrics.aiuMicros, "ch.aiuMicros");
  const aiuTolerance = parseMetricInteger(tolerance.aiuMicros, "aiuMicros tolerance");
  if ((aiuDelta < 0n ? -aiuDelta : aiuDelta) > aiuTolerance) {
    output.push(
      diff({
        type: "LEDGER_PROJECTION_MISSING",
        dimensions,
        pg,
        ch,
        deltaValues: { aiuMicros: aiuDelta.toString() },
        amount: null,
        explanation: "official AIU ledger total is not reflected in ClickHouse",
      }),
    );
  }
  const lateCount = parseMetricInteger(pg.lateEventCount, "lateEventCount");
  if (lateCount > 0n)
    output.push(
      diff({
        type: "LATE_EVENT",
        dimensions,
        pg,
        ch,
        count: lateCount.toString(),
        explanation:
          "events arrived after the aggregate watermark and require deterministic replay",
      }),
    );
  const adjustments = parseMetricInteger(
    pg.unprojectedAdjustmentCount,
    "unprojectedAdjustmentCount",
  );
  if (adjustments > 0n)
    output.push(
      diff({
        type: "ADJUSTMENT_NOT_PROJECTED",
        dimensions,
        pg,
        ch,
        count: adjustments.toString(),
        explanation: "append-only official corrections are missing from the projection",
      }),
    );
  return output;
}

export function reconcileSnapshots(input: {
  readonly pgRows: readonly ReconciliationSnapshotRow[];
  readonly chRows: readonly ReconciliationSnapshotRow[];
  readonly tolerance: ReconciliationTolerance;
  readonly watermark?: {
    readonly pgEventTime: string;
    readonly chEventTime: string;
    readonly chLastSuccessAt: string;
    readonly now: string;
  };
}): readonly ReconciliationDiff[] {
  const pg = group(input.pgRows);
  const ch = group(input.chRows);
  const output: ReconciliationDiff[] = [];
  for (const key of [...new Set([...pg.keys(), ...ch.keys()])].sort()) {
    const pgRows = pg.get(key) ?? [];
    const chRows = ch.get(key) ?? [];
    const dimensions = pgRows[0]?.dimensions ?? chRows[0]?.dimensions ?? null;
    const duplicateProjectionCount = [...pgRows, ...chRows].reduce(
      (total, row) =>
        total + parseMetricInteger(row.duplicateProjectionCount ?? "0", "duplicateProjectionCount"),
      BigInt(Math.max(0, pgRows.length - 1) + Math.max(0, chRows.length - 1)),
    );
    if (duplicateProjectionCount > 0n) {
      output.push(
        diff({
          type: "DUPLICATE_PROJECTION",
          dimensions,
          pg: pgRows[0] ?? null,
          ch: chRows[0] ?? null,
          count: duplicateProjectionCount.toString(),
          explanation:
            "duplicate physical projection rows or aggregate rows exist for the canonical dimension key",
        }),
      );
    }
    if (pgRows.length === 0) {
      output.push(
        diff({
          type: "PG_MISSING",
          dimensions,
          pg: null,
          ch: chRows[0] ?? null,
          explanation: "ClickHouse projection has no corresponding PostgreSQL official aggregate",
        }),
      );
      continue;
    }
    if (chRows.length === 0) {
      output.push(
        diff({
          type: "CH_MISSING",
          dimensions,
          pg: pgRows[0]!,
          ch: null,
          explanation: "PostgreSQL official aggregate has not been projected to ClickHouse",
        }),
      );
      continue;
    }
    output.push(...pairedDiffs(pgRows[0]!, chRows[0]!, input.tolerance));
  }

  if (input.watermark !== undefined) {
    const { pgEventTime, chEventTime, chLastSuccessAt, now } = input.watermark;
    const values = [pgEventTime, chEventTime, chLastSuccessAt, now].map(Date.parse);
    if (values.some((value) => !Number.isFinite(value)))
      throw new TypeError("watermark timestamps are invalid");
    const [pgTime, chTime, lastSuccess, current] = values as [number, number, number, number];
    if (chTime < pgTime && current - lastSuccess > input.tolerance.watermarkStallSeconds * 1000) {
      output.push(
        diff({
          type: "WATERMARK_STALLED",
          dimensions: null,
          pg: null,
          ch: null,
          count: "1",
          amount: null,
          explanation:
            "ClickHouse watermark is behind PostgreSQL and has not advanced within the configured interval",
        }),
      );
    }
  }
  return output;
}

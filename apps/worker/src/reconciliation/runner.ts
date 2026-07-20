import {
  canonicalReconciliationDecimal,
  exportReconciliationDiffsCsv,
  ReconciliationDecimal,
  reconcileSnapshots,
  redactReconciliationDimensions,
  type ReconciliationDiff,
  type ReconciliationMetrics,
  type ReconciliationRunPlan,
  type ReconciliationSnapshotRow,
  type ReconciliationTolerance,
} from "@tokenpilot/reconciliation-engine";

import {
  NOOP_RECONCILIATION_LOGGER,
  type ReconciliationRepository,
  type ReconciliationRunLogger,
  type ReconciliationRunSummary,
  type ReconciliationSnapshotSource,
} from "./types.js";

function safeError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Unknown reconciliation failure");
}

function metricInteger(value: string, field: string): bigint {
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`${field} must be an integer`);
  }
  return BigInt(value);
}

function summarize(
  diffs: readonly ReconciliationDiff[],
  pgRows: readonly ReconciliationSnapshotRow[],
  chRows: readonly ReconciliationSnapshotRow[],
): ReconciliationRunSummary {
  const byType: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const metricDiffs = new Map<
    string,
    {
      readonly type: ReconciliationDiff["type"];
      readonly severity: ReconciliationDiff["severity"];
      count: bigint;
    }
  >();
  const samples = new Set<string>();
  for (const diff of diffs) {
    byType[diff.type] = (byType[diff.type] ?? 0) + 1;
    bySeverity[diff.severity] = (bySeverity[diff.severity] ?? 0) + 1;
    const key = `${diff.type}:${diff.severity}`;
    const existing = metricDiffs.get(key);
    const persistedCount = metricInteger(diff.count, "reconciliation diff count");
    if (persistedCount < 0n) throw new TypeError("reconciliation diff count cannot be negative");
    const count = persistedCount === 0n ? 1n : persistedCount;
    metricDiffs.set(
      key,
      existing === undefined
        ? { type: diff.type, severity: diff.severity, count }
        : { ...existing, count: existing.count + count },
    );
    for (const eventId of diff.sampleEventIds) samples.add(eventId);
  }
  const providerCost = (rows: readonly ReconciliationSnapshotRow[]) =>
    rows.reduce(
      (sum, row) => sum.plus(new ReconciliationDecimal(row.metrics.providerCost)),
      new ReconciliationDecimal(0),
    );
  const aiuMicros = (rows: readonly ReconciliationSnapshotRow[]) =>
    rows.reduce(
      (sum, row) => sum + metricInteger(row.metrics.aiuMicros, "reconciliation AIU micros"),
      0n,
    );
  const integerTotal = (key: Exclude<keyof ReconciliationMetrics, "providerCost">): string =>
    pgRows
      .reduce(
        (sum, row) => sum + metricInteger(row.metrics[key], `reconciliation ${String(key)}`),
        0n,
      )
      .toString();
  return {
    totalDiffs: diffs.length,
    byType: Object.freeze(byType),
    bySeverity: Object.freeze(bySeverity),
    sampleEventCount: samples.size,
    metricDiffs: [...metricDiffs.values()]
      .sort((left, right) =>
        left.type === right.type
          ? left.severity.localeCompare(right.severity)
          : left.type.localeCompare(right.type),
      )
      .map((entry) => ({ ...entry, count: entry.count.toString() })),
    providerCostDelta: canonicalReconciliationDecimal(
      providerCost(pgRows).minus(providerCost(chRows)),
    ),
    aiuMicroDelta: (aiuMicros(pgRows) - aiuMicros(chRows)).toString(),
    authoritativeMetrics: {
      eventCount: integerTotal("eventCount"),
      inputTokens: integerTotal("inputTokens"),
      cachedInputTokens: integerTotal("cachedInputTokens"),
      outputTokens: integerTotal("outputTokens"),
      providerCost: canonicalReconciliationDecimal(providerCost(pgRows)),
      aiuMicros: integerTotal("aiuMicros"),
      unpricedCount: integerTotal("unpricedCount"),
      unratedCount: integerTotal("unratedCount"),
    },
  };
}

export interface ReconciliationRunnerOptions {
  readonly userHmacSecret: string | Uint8Array;
  readonly tolerance: ReconciliationTolerance;
  readonly now?: () => Date;
  readonly logger?: ReconciliationRunLogger;
}

/** Runs one durable application-bound comparison with pseudonymous user evidence. */
export class ReconciliationRunner {
  private readonly now: () => Date;
  private readonly logger: ReconciliationRunLogger;

  public constructor(
    private readonly repository: ReconciliationRepository,
    private readonly source: ReconciliationSnapshotSource,
    private readonly options: ReconciliationRunnerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? NOOP_RECONCILIATION_LOGGER;
    // Validate the secret eagerly without retaining a sample pseudonym.
    redactReconciliationDimensions(
      {
        bucketStart: new Date(0).toISOString(),
        bucketSize: "hour",
        applicationId: "secret-validation",
        virtualModel: null,
        modelId: null,
        modelTag: null,
        provider: null,
        userId: "secret-validation",
      },
      options.userHmacSecret,
    );
  }

  public queue(
    plan: ReconciliationRunPlan,
    requestedBy: string | null = null,
    idempotencyKey?: string,
  ): Promise<{ readonly id: string }> {
    return this.repository.createQueued(plan, requestedBy, idempotencyKey);
  }

  public applicationIds(): Promise<readonly string[]> {
    return this.repository.listApplicationIds();
  }

  public async execute(runId: string): Promise<ReconciliationRunSummary | null> {
    const claim = await this.repository.claim(runId);
    if (claim === null) return null;
    this.logger.info("reconciliation.run.started", {
      run_id: claim.id,
      run_type: claim.plan.runType,
      range_start: claim.plan.rangeStart,
      range_end: claim.plan.rangeEnd,
    });
    try {
      const [pgRows, chRows, watermarks] = await Promise.all([
        this.source.loadPostgres(claim.plan),
        this.source.loadClickHouse(claim.plan),
        this.source.loadWatermarks(claim.plan),
      ]);
      const rawDiffs = reconcileSnapshots({
        pgRows,
        chRows,
        tolerance: this.options.tolerance,
        watermark: { ...watermarks, now: this.now().toISOString() },
      });
      const diffs = rawDiffs.map((diff) => ({
        ...diff,
        dimensions:
          diff.dimensions === null
            ? null
            : redactReconciliationDimensions(diff.dimensions, this.options.userHmacSecret),
      }));
      const summary = summarize(diffs, pgRows, chRows);
      await this.repository.replaceDiffs(runId, diffs);
      await this.repository.complete(runId, watermarks, summary);
      this.logger.info("reconciliation.run.completed", {
        run_id: claim.id,
        total_diffs: summary.totalDiffs,
        sample_event_count: summary.sampleEventCount,
      });
      return summary;
    } catch (error) {
      const failure = safeError(error);
      await this.repository.fail(runId, failure);
      this.logger.error("reconciliation.run.failed", {
        run_id: claim.id,
        error_name: failure.name,
        error_message: failure.message,
      });
      throw failure;
    }
  }

  public async exportCsv(runId: string): Promise<string> {
    return exportReconciliationDiffsCsv(await this.repository.listDiffs(runId));
  }
}

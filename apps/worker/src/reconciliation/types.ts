import type {
  ReconciliationDiff,
  ReconciliationMetrics,
  ReconciliationRunPlan,
  ReconciliationSnapshotRow,
} from "@tokenpilot/reconciliation-engine";

export type ReconciliationRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ReconciliationWatermarks {
  readonly pgEventTime: string;
  readonly chEventTime: string;
  readonly chLastSuccessAt: string;
}

export interface ReconciliationRunClaim {
  readonly id: string;
  readonly plan: ReconciliationRunPlan;
}

export interface ReconciliationRunSummary {
  readonly totalDiffs: number;
  readonly byType: Readonly<Record<string, number>>;
  readonly bySeverity: Readonly<Record<string, number>>;
  readonly sampleEventCount: number;
  readonly metricDiffs: ReadonlyArray<{
    readonly type: ReconciliationDiff["type"];
    readonly severity: ReconciliationDiff["severity"];
    readonly count: string;
  }>;
  readonly providerCostDelta: string;
  readonly aiuMicroDelta: string;
  readonly authoritativeMetrics: ReconciliationMetrics;
}

export interface ReconciliationRepository {
  listApplicationIds(): Promise<readonly string[]>;
  createQueued(
    plan: ReconciliationRunPlan,
    requestedBy: string | null,
    idempotencyKey?: string,
  ): Promise<{ readonly id: string }>;
  claim(runId: string): Promise<ReconciliationRunClaim | null>;
  replaceDiffs(runId: string, diffs: readonly ReconciliationDiff[]): Promise<void>;
  complete(
    runId: string,
    watermarks: ReconciliationWatermarks,
    summary: ReconciliationRunSummary,
  ): Promise<void>;
  fail(runId: string, error: Error): Promise<void>;
  listDiffs(runId: string): Promise<readonly ReconciliationDiff[]>;
}

export interface ReconciliationSnapshotSource {
  loadPostgres(plan: ReconciliationRunPlan): Promise<readonly ReconciliationSnapshotRow[]>;
  loadClickHouse(plan: ReconciliationRunPlan): Promise<readonly ReconciliationSnapshotRow[]>;
  loadWatermarks(plan: ReconciliationRunPlan): Promise<ReconciliationWatermarks>;
}

export interface ReconciliationRunLogger {
  info(event: string, attributes: Readonly<Record<string, unknown>>): void;
  error(event: string, attributes: Readonly<Record<string, unknown>>): void;
}

export const NOOP_RECONCILIATION_LOGGER: ReconciliationRunLogger = {
  info: () => undefined,
  error: () => undefined,
};

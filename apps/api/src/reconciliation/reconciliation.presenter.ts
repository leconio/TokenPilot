import type { Prisma } from "@tokenpilot/db";

export function presentRun(run: {
  readonly id: string;
  readonly applicationId: string;
  readonly runType: string;
  readonly rangeStart: Date;
  readonly rangeEnd: Date;
  readonly status: string;
  readonly pgWatermark: Date | null;
  readonly chWatermark: Date | null;
  readonly scopeJson: Prisma.JsonValue;
  readonly summaryJson: Prisma.JsonValue;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly error: string | null;
  readonly startedBy: string | null;
  readonly _count?: { readonly diffs: number };
}) {
  return {
    id: run.id,
    application_id: run.applicationId,
    run_type: run.runType.toLowerCase(),
    range_start: run.rangeStart.toISOString(),
    range_end: run.rangeEnd.toISOString(),
    status: run.status.toLowerCase(),
    pg_watermark: run.pgWatermark?.toISOString() ?? null,
    ch_watermark: run.chWatermark?.toISOString() ?? null,
    summary: run.summaryJson,
    started_by: run.startedBy,
    error: run.error,
    started_at: run.startedAt.toISOString(),
    finished_at: run.finishedAt?.toISOString() ?? null,
  };
}

export function presentDiff(diff: {
  readonly id: string;
  readonly runId: string;
  readonly diffType: string;
  readonly severity: string;
  readonly dimensionsJson: Prisma.JsonValue | null;
  readonly pgValuesJson: Prisma.JsonValue | null;
  readonly chValuesJson: Prisma.JsonValue | null;
  readonly deltaValuesJson: Prisma.JsonValue;
  readonly sampleEventIdsJson: Prisma.JsonValue;
  readonly differenceCount: bigint;
  readonly amount: Prisma.Decimal | null;
  readonly explanation: string;
  readonly status: string;
  readonly resolution: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
}) {
  return {
    id: diff.id,
    run_id: diff.runId,
    diff_type: diff.diffType,
    severity: diff.severity.toLowerCase(),
    dimensions: diff.dimensionsJson,
    pg_values: diff.pgValuesJson,
    ch_values: diff.chValuesJson,
    delta_values: diff.deltaValuesJson,
    count: diff.differenceCount.toString(),
    amount: diff.amount?.toString() ?? null,
    sample_event_ids: diff.sampleEventIdsJson,
    explanation: diff.explanation,
    status: diff.status.toLowerCase(),
    resolution: diff.resolution,
    resolved_by: diff.resolvedBy,
    resolved_at: diff.resolvedAt?.toISOString() ?? null,
    created_at: diff.createdAt.toISOString(),
  };
}

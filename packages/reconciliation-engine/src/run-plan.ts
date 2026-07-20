import type { ReconciliationDiff } from "./types.js";

export interface ReconciliationRunPlan {
  readonly applicationId: string;
  readonly runType: "hourly" | "daily" | "manual";
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly virtualModel: string | null;
  readonly modelId: string | null;
  readonly userId: string | null;
  readonly asynchronous: boolean;
  readonly expectedPgWatermark: string | null;
  readonly expectedChWatermark: string | null;
}

function time(value: string, field: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${field} is invalid`);
  return parsed;
}

export function planReconciliationRun(input: {
  readonly applicationId: string;
  readonly runType: "hourly" | "daily" | "manual";
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly virtualModel?: string;
  readonly modelId?: string;
  readonly userId?: string;
  readonly pgWatermark?: string;
  readonly chWatermark?: string;
}): ReconciliationRunPlan {
  const start = time(input.rangeStart, "rangeStart");
  const end = time(input.rangeEnd, "rangeEnd");
  if (end <= start) throw new TypeError("reconciliation rangeEnd must follow rangeStart");
  const width = end.getTime() - start.getTime();
  if (input.runType === "hourly" && width !== 3_600_000) {
    throw new TypeError("hourly reconciliation must cover exactly one hour");
  }
  if (input.runType === "daily" && width !== 86_400_000) {
    throw new TypeError("daily reconciliation must cover exactly one UTC day");
  }
  if (width > 366 * 86_400_000)
    throw new TypeError("one reconciliation run cannot exceed 366 days");
  if (input.applicationId.trim().length === 0) throw new TypeError("applicationId is required");
  return {
    applicationId: input.applicationId,
    runType: input.runType,
    rangeStart: start.toISOString(),
    rangeEnd: end.toISOString(),
    virtualModel: input.virtualModel ?? null,
    modelId: input.modelId ?? null,
    userId: input.userId ?? null,
    asynchronous: input.runType !== "manual" || width > 3_600_000,
    expectedPgWatermark: input.pgWatermark ?? null,
    expectedChWatermark: input.chWatermark ?? null,
  };
}

function csv(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportReconciliationDiffsCsv(diffs: readonly ReconciliationDiff[]): string {
  const header = [
    "type",
    "severity",
    "bucket_start",
    "bucket_size",
    "count",
    "amount",
    "delta_values",
    "sample_event_ids",
    "explanation",
  ];
  const rows = diffs.map((entry) => [
    entry.type,
    entry.severity,
    entry.dimensions?.bucketStart ?? null,
    entry.dimensions?.bucketSize ?? null,
    entry.count,
    entry.amount,
    entry.deltaValues,
    entry.sampleEventIds,
    entry.explanation,
  ]);
  return `${[header, ...rows].map((row) => row.map(csv).join(",")).join("\n")}\n`;
}

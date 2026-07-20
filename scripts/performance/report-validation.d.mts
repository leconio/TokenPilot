export const REQUIRED_THRESHOLDS: readonly string[];

export interface PerformanceReportBinding {
  readonly project: string;
  readonly runId: string;
  readonly sourceSha: string;
  readonly executionNonceSha256: string;
  readonly clickhouseUsername: string;
}

export interface PerformanceValidationSummary {
  status: "passed" | "failed";
  readonly checks: readonly ["clickhouse", "pipeline", "runtime", "reports"];
  readonly thresholds_checked: readonly string[];
  readonly failures: string[];
}

export function thresholdsDigest(thresholds: Readonly<Record<string, number>>): string;
export function evaluatePerformanceReport(
  report: unknown,
  thresholds: unknown,
  expected: PerformanceReportBinding,
): PerformanceValidationSummary;

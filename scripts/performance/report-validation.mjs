import { createHash } from "node:crypto";

import { finiteSamples, percentile, REQUIRED_SAMPLE_COUNT } from "./statistics.mjs";

export const REQUIRED_THRESHOLDS = Object.freeze([
  "ingestion_batch_p95_ms",
  "settlement_lag_p95_seconds",
  "dashboard_p95_ms",
  "usage_report_p95_ms",
  "provider_cost_report_p95_ms",
  "aiu_report_p95_ms",
  "runtime_snapshot_p95_ms",
  "reservation_p95_ms",
]);

function record(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function finite(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function sameNumber(left, right) {
  return Math.abs(left - right) <= 0.001;
}

function measuredSummary(value, name) {
  const summary = record(value, name);
  const samples = finiteSamples(summary.samples, `${name}.samples`);
  if (summary.count !== samples.length || summary.count < REQUIRED_SAMPLE_COUNT) {
    throw new TypeError(`${name}.count does not match the required samples`);
  }
  for (const [key, quantile] of [
    ["p50", 0.5],
    ["p95", 0.95],
    ["p99", 0.99],
  ]) {
    if (!sameNumber(finite(summary[key], `${name}.${key}`), percentile(samples, quantile))) {
      throw new TypeError(`${name}.${key} does not match its samples`);
    }
  }
  if (!sameNumber(finite(summary.maximum, `${name}.maximum`), Math.max(...samples))) {
    throw new TypeError(`${name}.maximum does not match its samples`);
  }
  return summary;
}

function exactKeys(value, expected, name) {
  const actual = Object.keys(record(value, name)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new TypeError(`${name} must contain exactly ${wanted.join(", ")}`);
  }
}

function validateBinding(report, expected) {
  if (
    report.project !== expected.project ||
    report.run_id !== expected.runId ||
    report.source_sha !== expected.sourceSha ||
    report.execution_nonce_sha256 !== expected.executionNonceSha256
  ) {
    throw new TypeError("report does not match the active isolated project/run/source binding");
  }
  if (
    report.schema_version !== "2.0" ||
    report.benchmark !== "remote_capacity_baseline" ||
    report.origin !== "executed" ||
    report.target !== "isolated" ||
    report.contains_secrets !== false
  ) {
    throw new TypeError("report provenance is invalid");
  }
}

function validateMeasurements(report, expected) {
  const clickhouse = record(report.clickhouse, "clickhouse");
  if (
    clickhouse.status !== "measured" ||
    clickhouse.username !== expected.clickhouseUsername ||
    clickhouse.samples_verified !== REQUIRED_SAMPLE_COUNT
  ) {
    throw new TypeError("ClickHouse application identity was not measured");
  }
  measuredSummary(clickhouse.query_latency_ms, "clickhouse.query_latency_ms");

  const pipeline = record(report.pipeline, "pipeline");
  if (
    pipeline.status !== "measured" ||
    pipeline.batch_size !== 25 ||
    pipeline.samples_verified !== REQUIRED_SAMPLE_COUNT ||
    !Array.isArray(pipeline.sample_evidence) ||
    pipeline.sample_evidence.length !== REQUIRED_SAMPLE_COUNT ||
    pipeline.sample_evidence.some(
      (sample) =>
        sample?.accepted_events !== 25 ||
        sample?.rated_request !== true ||
        sample?.actual_model !== true,
    )
  ) {
    throw new TypeError("current usage pipeline evidence is incomplete");
  }
  const ingestion = measuredSummary(pipeline.ingestion_latency_ms, "pipeline.ingestion_latency_ms");
  const settlement = measuredSummary(
    pipeline.settlement_lag_seconds,
    "pipeline.settlement_lag_seconds",
  );

  const runtime = record(report.runtime, "runtime");
  if (runtime.status !== "measured" || runtime.samples_verified !== REQUIRED_SAMPLE_COUNT) {
    throw new TypeError("runtime configuration and AIU reservation were not measured");
  }
  const snapshot = measuredSummary(runtime.snapshot_latency_ms, "runtime.snapshot_latency_ms");
  const reservation = measuredSummary(
    runtime.reservation_create_release_latency_ms,
    "runtime.reservation_create_release_latency_ms",
  );

  const reports = record(report.reports, "reports");
  if (reports.status !== "measured" || reports.samples_verified !== REQUIRED_SAMPLE_COUNT) {
    throw new TypeError("application reports were not measured");
  }
  return {
    ingestion,
    settlement,
    snapshot,
    reservation,
    dashboard: measuredSummary(reports.dashboard_latency_ms, "reports.dashboard_latency_ms"),
    usage: measuredSummary(reports.usage_latency_ms, "reports.usage_latency_ms"),
    cost: measuredSummary(reports.provider_cost_latency_ms, "reports.provider_cost_latency_ms"),
    aiu: measuredSummary(reports.aiu_latency_ms, "reports.aiu_latency_ms"),
  };
}

function expectedWorkloads(measured) {
  return {
    ingestion_batch_p95_ms: measured.ingestion.p95,
    settlement_lag_p95_seconds: measured.settlement.p95,
    dashboard_p95_ms: measured.dashboard.p95,
    usage_report_p95_ms: measured.usage.p95,
    provider_cost_report_p95_ms: measured.cost.p95,
    aiu_report_p95_ms: measured.aiu.p95,
    runtime_snapshot_p95_ms: measured.snapshot.p95,
    reservation_p95_ms: measured.reservation.p95,
  };
}

export function thresholdsDigest(thresholds) {
  const canonical = `${JSON.stringify(
    Object.fromEntries(
      Object.entries(thresholds).sort(([left], [right]) => left.localeCompare(right)),
    ),
  )}\n`;
  return createHash("sha256").update(canonical).digest("hex");
}

export function evaluatePerformanceReport(reportValue, thresholdsValue, expected) {
  const failures = [];
  try {
    const report = record(reportValue, "report");
    const thresholds = record(thresholdsValue, "thresholds");
    validateBinding(report, expected);
    exactKeys(thresholds, REQUIRED_THRESHOLDS, "thresholds");
    exactKeys(report.workloads, REQUIRED_THRESHOLDS, "workloads");
    const observed = expectedWorkloads(validateMeasurements(report, expected));
    for (const name of REQUIRED_THRESHOLDS) {
      const reported = finite(report.workloads[name], `workloads.${name}`);
      const limit = finite(thresholds[name], `thresholds.${name}`);
      if (limit <= 0) throw new TypeError(`thresholds.${name} must be positive`);
      if (!sameNumber(reported, observed[name]))
        failures.push(`${name} does not match raw samples`);
      if (reported > limit) failures.push(`${name} exceeded ${limit}`);
    }
    if (report.thresholds_sha256 !== thresholdsDigest(thresholds)) {
      failures.push("threshold digest does not match the enforced thresholds");
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "performance report is invalid");
  }
  return {
    status: failures.length === 0 ? "passed" : "failed",
    checks: ["clickhouse", "pipeline", "runtime", "reports"],
    thresholds_checked: [...REQUIRED_THRESHOLDS].sort(),
    failures,
  };
}

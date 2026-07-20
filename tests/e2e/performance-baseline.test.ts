import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  evaluatePerformanceReport,
  thresholdsDigest,
} from "../../scripts/performance/report-validation.mjs";
import {
  collectPerformanceStages,
  performanceModelFromSnapshot,
  performanceFailureDiagnostic,
  runPerformanceStage,
} from "../../scripts/performance/remote-acceptance-runner.mjs";
import { loadRemotePerformanceContext } from "../../scripts/performance/remote-context.mjs";
import { sampleSummary } from "../../scripts/performance/statistics.mjs";

const execute = promisify(execFile);
const root = new URL("../../", import.meta.url);
const binding = {
  project: "tokenpilot-acceptance-20260716120000-123-abcdef",
  runId: "20260716120000-123-abcdef",
  sourceSha: "a".repeat(40),
  executionNonceSha256: "b".repeat(64),
  clickhouseUsername: "tokenpilot_app",
};
const thresholds = {
  ingestion_batch_p95_ms: 2000,
  settlement_lag_p95_seconds: 60,
  dashboard_p95_ms: 2000,
  usage_report_p95_ms: 2000,
  provider_cost_report_p95_ms: 2000,
  aiu_report_p95_ms: 2000,
  runtime_snapshot_p95_ms: 500,
  reservation_p95_ms: 1000,
};

function repeated(value: number): ReturnType<typeof sampleSummary> {
  return sampleSummary(Array.from({ length: 7 }, () => value));
}

function measuredReport() {
  return {
    schema_version: "2.0",
    benchmark: "remote_capacity_baseline",
    origin: "executed",
    target: "isolated",
    contains_secrets: false,
    project: binding.project,
    run_id: binding.runId,
    source_sha: binding.sourceSha,
    execution_nonce_sha256: binding.executionNonceSha256,
    status: "measured",
    thresholds_sha256: thresholdsDigest(thresholds),
    clickhouse: {
      status: "measured",
      username: binding.clickhouseUsername,
      samples_verified: 7,
      query_latency_ms: repeated(3),
    },
    pipeline: {
      status: "measured",
      batch_size: 25,
      samples_verified: 7,
      ingestion_latency_ms: repeated(10),
      settlement_lag_seconds: repeated(1),
      sample_evidence: Array.from({ length: 7 }, () => ({
        accepted_events: 25,
        rated_request: true,
        actual_model: true,
        request_id: "performance-request",
      })),
    },
    runtime: {
      status: "measured",
      samples_verified: 7,
      snapshot_latency_ms: repeated(4),
      reservation_create_release_latency_ms: repeated(5),
    },
    reports: {
      status: "measured",
      samples_verified: 7,
      dashboard_latency_ms: repeated(30),
      usage_latency_ms: repeated(20),
      provider_cost_latency_ms: repeated(40),
      aiu_latency_ms: repeated(35),
    },
    workloads: {
      ingestion_batch_p95_ms: 10,
      settlement_lag_p95_seconds: 1,
      dashboard_p95_ms: 30,
      usage_report_p95_ms: 20,
      provider_cost_report_p95_ms: 40,
      aiu_report_p95_ms: 35,
      runtime_snapshot_p95_ms: 4,
      reservation_p95_ms: 5,
    },
  };
}

describe("remote capacity baseline", () => {
  it("resolves the real model driver from the published connection map", () => {
    expect(
      performanceModelFromSnapshot({
        connections: {
          "connection-id": { driver: "litellm" },
        },
        routing: {
          "acceptance.chat": {
            default: {
              targets: [
                {
                  model_id: "model-id",
                  connection_id: "connection-id",
                  request_model: "text.fast.demo-fallback",
                  provider: "openai",
                },
              ],
            },
          },
        },
      }),
    ).toEqual({
      id: "model-id",
      connection_id: "connection-id",
      connection_driver: "litellm",
      request_model: "text.fast.demo-fallback",
      provider: "openai",
    });
    expect(() =>
      performanceModelFromSnapshot({
        connections: {},
        routing: {
          "acceptance.chat": {
            default: {
              targets: [
                {
                  model_id: "model-id",
                  connection_id: "missing-connection",
                  request_model: "text.fast.demo-fallback",
                },
              ],
            },
          },
        },
      }),
    ).toThrow("Performance model is unavailable");
  });

  it("uses only current application-scoped workload paths and bounded batches", async () => {
    const source = await readFile(
      new URL("../../scripts/performance/remote-acceptance-runner.mjs", import.meta.url),
      "utf8",
    );
    expect(source).toContain("/usage-events/batch");
    expect(source).toContain("/runtime/users/aiu/reservations");
    expect(source).toContain("/runtime/snapshot");
    expect(source).toContain("/reports/provider-cost");
    expect(source).toContain("/reports/aiu");
    expect(source).toContain("const batchSize = 25");
    expect(source).not.toContain("10000000");
    expect(source).not.toContain("/runtime/quota/check");
    expect(source).not.toContain("/runtime/aiu/reservations");
    expect(source).not.toContain("wallet");
  });

  it("accepts a complete project-bound report whose metrics match raw samples", () => {
    expect(evaluatePerformanceReport(measuredReport(), thresholds, binding)).toEqual({
      status: "passed",
      checks: ["clickhouse", "pipeline", "runtime", "reports"],
      thresholds_checked: Object.keys(thresholds).sort(),
      failures: [],
    });
  });

  it("rejects forged samples, mismatched run binding, and exceeded thresholds", () => {
    const forged = measuredReport();
    forged.pipeline.ingestion_latency_ms = { ...forged.pipeline.ingestion_latency_ms, p95: 0 };
    expect(evaluatePerformanceReport(forged, thresholds, binding).failures.join(" ")).toContain(
      "does not match its samples",
    );

    const mismatched = measuredReport();
    mismatched.run_id = "20260716120000-999-abcdef";
    expect(evaluatePerformanceReport(mismatched, thresholds, binding).failures.join(" ")).toContain(
      "does not match",
    );

    const slow = measuredReport();
    slow.pipeline.ingestion_latency_ms = repeated(2001);
    slow.workloads.ingestion_batch_p95_ms = 2001;
    expect(evaluatePerformanceReport(slow, thresholds, binding).failures).toContain(
      "ingestion_batch_p95_ms exceeded 2000",
    );
  });

  it("reports independent stage failures without retaining secrets or payloads", async () => {
    const secret = "performance-secret-api-key";
    let diagnostic = "";
    try {
      await runPerformanceStage("pipeline", async () => {
        throw new Error(
          `Bearer ${secret} request={"prompt":"private"} response="private" status 503`,
        );
      });
    } catch (error) {
      diagnostic = performanceFailureDiagnostic(error);
    }
    expect(diagnostic).toContain("stage=pipeline");
    expect(diagnostic).toContain("message=dependency returned HTTP status 503");
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toMatch(/Bearer|prompt|private/iu);

    await expect(
      runPerformanceStage("pipeline", async () => {
        throw new Error("Performance batch was not accepted completely");
      }),
    ).rejects.toMatchObject({ message: "ingestion batch was not accepted completely" });

    const executed: string[] = [];
    const stages = await collectPerformanceStages([
      {
        name: "first",
        operation: async () => {
          executed.push("first");
          throw new Error("status 503 with secret payload");
        },
      },
      {
        name: "independent",
        operation: async () => {
          executed.push("independent");
          return 2;
        },
      },
      {
        name: "dependent",
        blockedBy: ["first"],
        operation: async () => {
          executed.push("dependent");
          return 3;
        },
      },
    ]);
    expect(executed).toEqual(["first", "independent"]);
    expect(stages.stages.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: "first", status: "FAIL" },
      { name: "independent", status: "PASS" },
      { name: "dependent", status: "BLOCKED" },
    ]);
    expect(JSON.stringify(stages)).not.toContain("secret payload");
  });

  it("requires the guarded isolated Linux application context", () => {
    const environment = {
      REMOTE_DOCKER_ACCEPTANCE: "1",
      PERF_ISOLATED_STACK: "true",
      ACCEPTANCE_PROJECT: binding.project,
      ACCEPTANCE_RUN_ID: binding.runId,
      SOURCE_SHA: binding.sourceSha,
      ACCEPTANCE_PERFORMANCE_NONCE: "c".repeat(64),
      DATABASE_URL: "postgresql://user:password@postgres:5432/tokenpilot",
      PERF_API_URL: "http://api:4000",
      PERF_APPLICATION_SLUG: "acceptance",
      PERF_INGEST_API_KEY: "secret-ingest",
      PERF_READ_API_KEY: "secret-read",
      PERF_RUNTIME_API_KEY: "secret-runtime",
      CLICKHOUSE_URL: "http://clickhouse:8123",
      CLICKHOUSE_DATABASE: "tokenpilot",
      CLICKHOUSE_USERNAME: binding.clickhouseUsername,
      CLICKHOUSE_PASSWORD: "valid-password-value",
    };
    expect(loadRemotePerformanceContext(environment, "linux")).toMatchObject({
      project: binding.project,
      runId: binding.runId,
      applicationSlug: "acceptance",
    });
    expect(() => loadRemotePerformanceContext(environment, "darwin")).toThrow(/guarded Linux/u);
  });

  it("refuses to run the baseline on this workstation", async () => {
    await expect(
      execute(process.execPath, ["scripts/performance-baseline.mjs"], {
        cwd: root,
        env: { ...process.env, REMOTE_DOCKER_ACCEPTANCE: undefined },
      }),
    ).rejects.toMatchObject({ code: 2 });
  });
});

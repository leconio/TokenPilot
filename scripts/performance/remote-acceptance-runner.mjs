import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ulid } from "ulid";

import { evaluatePerformanceReport, thresholdsDigest } from "./report-validation.mjs";
import { loadRemotePerformanceContext, parseRemoteArguments } from "./remote-context.mjs";
import { sampleSummary } from "./statistics.mjs";
import {
  collectPerformanceStages,
  performanceFailureDiagnostic,
  runPerformanceStage,
} from "./performance-stages.mjs";

export {
  collectPerformanceStages,
  performanceFailureDiagnostic,
  runPerformanceStage,
} from "./performance-stages.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const thresholdsPath = resolve(root, "scripts/performance/thresholds.json");
const repetitions = 7;
const batchSize = 25;

class PerformancePipelineStepError extends Error {
  constructor(step) {
    super(`Performance pipeline step failed: ${step}`);
    this.name = "PerformancePipelineStepError";
  }
}

async function pipelineStep(step, operation) {
  try {
    return await operation();
  } catch {
    throw new PerformancePipelineStepError(step);
  }
}

async function jsonRequest(context, path, key, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("accept", "application/json");
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (key !== undefined) headers.set("authorization", `Bearer ${key}`);
  const response = await fetch(`${context.apiUrl}${path}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  const body = text === "" ? null : JSON.parse(text);
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} status ${response.status}`);
  return { response, body };
}

function applicationPath(context, suffix) {
  return `/applications/${encodeURIComponent(context.applicationSlug)}${suffix}`;
}

export function performanceEvent(context, model, index, run) {
  const eventId = ulid();
  const requestId = `perf-${context.runId}-${run}-${String(index).padStart(2, "0")}`;
  const now = new Date().toISOString();
  return {
    schema_version: "2.0",
    event_id: eventId,
    event_time: now,
    user: { user_id: `perf-user-${context.runId}`, display_user: "Performance user" },
    source: {
      type: "sdk",
      name: "remote-performance",
      version: "current",
      instance_id: `performance-${context.runId}`,
    },
    request: {
      request_id: requestId,
      attempt_id: `${requestId}-attempt`,
      operation_id: `${requestId}-operation`,
      parent_request_id: null,
      session_id: null,
      conversation_id: null,
      trace_id: `${requestId}-trace`,
    },
    model: {
      virtual_model: "acceptance.chat",
      model_id: model.id,
      model_tag: model.litellm_tag,
      provider: model.provider,
    },
    route: null,
    usage: { uncached_input_tokens: "100", output_tokens: "25", request_count: "1" },
    analytics_dimensions: {},
    result: { status: "success", http_status: 200, latency_ms: 10, error_class: null },
    source_cost: null,
    privacy: { contains_prompt: false, contains_response: false },
  };
}

async function modelForPerformance(context) {
  const result = await jsonRequest(context, "/runtime/snapshot", context.runtimeKey);
  const targets = result.body?.routing?.["acceptance.chat"]?.default?.targets;
  const model = Array.isArray(targets)
    ? targets.find((candidate) => candidate?.model_tag === "text.fast.demo-fallback")
    : undefined;
  if (typeof model?.model_id !== "string") throw new Error("Performance model is unavailable");
  return {
    id: model.model_id,
    litellm_tag: model.model_tag,
    provider: typeof model.provider === "string" ? model.provider : null,
  };
}

function reportParameters(requestId) {
  const now = Date.now();
  return new URLSearchParams({
    from: new Date(now - 86_400_000).toISOString(),
    to: new Date(now + 60_000).toISOString(),
    timezone: "UTC",
    conditions: JSON.stringify([
      { kind: "builtin", field: "request_id", operator: "equals", values: [requestId] },
    ]),
  });
}

async function usageReport(context, requestId) {
  const parameters = reportParameters(requestId);
  parameters.set("page_size", "25");
  return jsonRequest(
    context,
    `${applicationPath(context, "/reports/usage")}?${parameters}`,
    context.readKey,
  );
}

async function waitForRatedUsage(context, requestId) {
  const started = performance.now();
  const deadline = started + 120_000;
  while (performance.now() < deadline) {
    const result = await usageReport(context, requestId);
    const item = result.body?.data?.items?.find((candidate) => candidate.request_id === requestId);
    if (typeof item?.provider_cost_amount === "string" && typeof item?.aiu_micros === "string") {
      return {
        seconds: (performance.now() - started) / 1_000,
        model_tag: item.model_tag,
        provider_cost_amount: item.provider_cost_amount,
        aiu_micros: item.aiu_micros,
      };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("Rated usage timed out");
}

async function benchmarkPipeline(context) {
  // The release-tooling image installs only the root workspace dependencies.
  // Load the package build that the image produces instead of relying on a
  // root-level workspace symlink that is intentionally absent there.
  const { usageBatchSchema } = await import("../../packages/contracts/dist/index.js");
  const model = await pipelineStep("published-model", () => modelForPerformance(context));
  const ingestion = [];
  const settlement = [];
  const evidence = [];
  for (let run = 0; run < repetitions; run += 1) {
    const events = Array.from({ length: batchSize }, (_, index) =>
      performanceEvent(context, model, index, run),
    );
    const batch = await pipelineStep("batch-contract", () =>
      usageBatchSchema.parse({
        schema_version: "2.0",
        batch_id: `performance-${ulid()}`,
        sent_at: new Date().toISOString(),
        events,
      }),
    );
    const started = performance.now();
    const response = await pipelineStep("batch-ingestion", async () => {
      const ingested = await jsonRequest(context, "/usage-events/batch", context.ingestKey, {
        method: "POST",
        body: JSON.stringify(batch),
      });
      if (ingested.response.status !== 202 || ingested.body?.accepted !== batchSize) {
        throw new Error("Performance batch was not accepted completely");
      }
      return ingested;
    });
    ingestion.push(performance.now() - started);
    void response;
    const lastRequest = events.at(-1).request.request_id;
    const rated = await pipelineStep("rated-usage", () => waitForRatedUsage(context, lastRequest));
    settlement.push(rated.seconds);
    await pipelineStep("rating-evidence", () => {
      if (
        rated.model_tag !== model.litellm_tag ||
        Number(rated.provider_cost_amount) <= 0 ||
        BigInt(rated.aiu_micros) <= 0n
      ) {
        throw new Error("Performance rating did not use the actual model");
      }
    });
    evidence.push({
      accepted_events: batchSize,
      rated_request: true,
      actual_model: true,
      request_id: lastRequest,
    });
  }
  return {
    status: "measured",
    batch_size: batchSize,
    samples_verified: repetitions,
    ingestion_latency_ms: sampleSummary(ingestion),
    settlement_lag_seconds: sampleSummary(settlement),
    sample_evidence: evidence,
  };
}

async function ensureRuntimeUser(context) {
  const created = await jsonRequest(context, applicationPath(context, "/users"), context.readKey, {
    method: "POST",
    body: JSON.stringify({
      user_id: `performance-quota-${context.runId}`,
      display_user: "Performance quota user",
    }),
  });
  const userId = created.body?.id;
  if (typeof userId !== "string") throw new Error("Performance quota user was not created");
  await jsonRequest(context, applicationPath(context, `/users/${userId}/quota`), context.readKey, {
    method: "PUT",
    body: JSON.stringify({ limit: "100", hard_limit: true }),
  });
  return `performance-quota-${context.runId}`;
}

async function benchmarkRuntime(context) {
  const userId = await ensureRuntimeUser(context);
  const snapshotSamples = [];
  const reservationSamples = [];
  for (let run = 0; run < repetitions; run += 1) {
    let started = performance.now();
    const snapshot = await jsonRequest(context, "/runtime/snapshot", context.runtimeKey);
    snapshotSamples.push(performance.now() - started);
    if (snapshot.body?.routing?.["acceptance.chat"] === undefined) {
      throw new Error("Published runtime route is unavailable");
    }
    started = performance.now();
    const reserved = await jsonRequest(
      context,
      "/runtime/users/aiu/reservations",
      context.runtimeKey,
      {
        method: "POST",
        body: JSON.stringify({
          user_id: userId,
          operation_id: `performance-${ulid()}`,
          virtual_model: "acceptance.chat",
          estimated_aiu_micros: "1000",
        }),
      },
    );
    const reservation = reserved.body?.reservation;
    if (reserved.body?.allowed !== true || typeof reservation?.id !== "string") {
      throw new Error("Performance reservation was denied");
    }
    await jsonRequest(
      context,
      `/runtime/users/aiu/reservations/${reservation.id}/release`,
      context.runtimeKey,
      {
        method: "POST",
        body: JSON.stringify({
          reservation_token: reservation.token,
          reason: "Remote performance sample completed",
        }),
      },
    );
    reservationSamples.push(performance.now() - started);
  }
  return {
    status: "measured",
    samples_verified: repetitions,
    snapshot_latency_ms: sampleSummary(snapshotSamples),
    reservation_create_release_latency_ms: sampleSummary(reservationSamples),
  };
}

async function timedReport(context, suffix, requestId, validate) {
  const samples = [];
  for (let run = 0; run < repetitions; run += 1) {
    const parameters = reportParameters(requestId);
    if (suffix === "/reports/provider-cost" || suffix === "/reports/aiu") {
      parameters.set("group_dimension", "model_tag");
      parameters.set("page_size", "20");
    }
    const started = performance.now();
    const result = await jsonRequest(
      context,
      `${applicationPath(context, suffix)}?${parameters}`,
      context.readKey,
    );
    samples.push(performance.now() - started);
    validate(result.body?.data);
  }
  return sampleSummary(samples);
}

async function benchmarkReports(context, pipeline) {
  const requestId = pipeline.sample_evidence.at(-1)?.request_id;
  const probe = await usageReport(context, requestId ?? "");
  const item = probe.body?.data?.items?.[0];
  const ratedRequest = item?.request_id;
  if (typeof ratedRequest !== "string") throw new Error("Performance report probe is unavailable");
  return {
    status: "measured",
    samples_verified: repetitions,
    usage_latency_ms: await timedReport(context, "/reports/usage", ratedRequest, (data) => {
      if (!Array.isArray(data?.items) || data.items.length !== 1) {
        throw new Error("Usage report did not return the measured request");
      }
    }),
    dashboard_latency_ms: await timedReport(context, "/reports/overview", ratedRequest, (data) => {
      if (data?.requests !== 1) throw new Error("Dashboard did not return the measured request");
    }),
    provider_cost_latency_ms: await timedReport(
      context,
      "/reports/provider-cost",
      ratedRequest,
      (data) => {
        if (Number(data?.total?.value) <= 0) throw new Error("AI cost report is empty");
      },
    ),
    aiu_latency_ms: await timedReport(context, "/reports/aiu", ratedRequest, (data) => {
      if (BigInt(data?.total?.micros ?? "0") <= 0n) throw new Error("AIU report is empty");
    }),
  };
}

async function benchmarkClickHouse(client, username) {
  const samples = [];
  for (let run = 0; run < repetitions; run += 1) {
    const started = performance.now();
    const result = await client.query({
      query: "SELECT currentUser() AS username",
      format: "JSONEachRow",
    });
    const [row] = await result.json();
    samples.push(performance.now() - started);
    if (row?.username !== username) throw new Error("ClickHouse application identity is invalid");
  }
  return {
    status: "measured",
    username,
    samples_verified: repetitions,
    query_latency_ms: sampleSummary(samples),
  };
}

function performanceMetrics(results) {
  return {
    ingestion_batch_p95_ms: results.pipeline.ingestion_latency_ms.p95,
    settlement_lag_p95_seconds: results.pipeline.settlement_lag_seconds.p95,
    dashboard_p95_ms: results.reports.dashboard_latency_ms.p95,
    usage_report_p95_ms: results.reports.usage_latency_ms.p95,
    provider_cost_report_p95_ms: results.reports.provider_cost_latency_ms.p95,
    aiu_report_p95_ms: results.reports.aiu_latency_ms.p95,
    runtime_snapshot_p95_ms: results.runtime.snapshot_latency_ms.p95,
    reservation_p95_ms: results.runtime.reservation_create_release_latency_ms.p95,
  };
}

async function protectedWrite(path, document) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function runRemotePerformanceAcceptance(arguments_, environment = process.env) {
  const options = await runPerformanceStage("argument-validation", () =>
    parseRemoteArguments(arguments_),
  );
  const context = await runPerformanceStage("context-validation", () =>
    loadRemotePerformanceContext(environment),
  );
  const thresholds = await runPerformanceStage("threshold-load", async () =>
    JSON.parse(await readFile(thresholdsPath, "utf8")),
  );
  const clickhousePackage = await runPerformanceStage(
    "package-load",
    () => import("@tokenpilot/clickhouse"),
  );
  const clickhouseConfig = clickhousePackage.loadClickHouseConfig({
    ...environment,
    CLICKHOUSE_REQUEST_TIMEOUT_MS: "120000",
  });
  const client = clickhousePackage.createClickHouseClient(clickhouseConfig);
  const boundContext = {
    ...context,
    apiUrl: environment.PERF_API_URL,
    applicationSlug: environment.PERF_APPLICATION_SLUG,
    ingestKey: environment.PERF_INGEST_API_KEY,
    readKey: environment.PERF_READ_API_KEY,
    runtimeKey: environment.PERF_RUNTIME_API_KEY,
  };
  const startedAt = new Date();
  try {
    const measurement = await collectPerformanceStages([
      {
        name: "clickhouse",
        operation: () => benchmarkClickHouse(client, clickhouseConfig.username),
      },
      { name: "pipeline", operation: () => benchmarkPipeline(boundContext) },
      { name: "runtime", operation: () => benchmarkRuntime(boundContext) },
      {
        name: "reports",
        blockedBy: ["pipeline"],
        operation: (results) => benchmarkReports(boundContext, results.pipeline),
      },
    ]);
    const measured = ["clickhouse", "pipeline", "runtime", "reports"].every(
      (name) => measurement.statuses[name] === "PASS",
    );
    const report = {
      schema_version: "2.0",
      benchmark: "remote_capacity_baseline",
      origin: "executed",
      target: "isolated",
      contains_secrets: false,
      project: context.project,
      run_id: context.runId,
      source_sha: context.sourceSha,
      execution_nonce_sha256: context.executionNonceSha256,
      status: measured ? "measured" : "failed",
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        cpu_count: os.cpus().length,
        memory_bytes: os.totalmem(),
      },
      sampling: { repetitions, batch_size: batchSize, percentile_method: "nearest_rank" },
      thresholds_sha256: thresholdsDigest(thresholds),
      clickhouse: measurement.results.clickhouse,
      pipeline: measurement.results.pipeline,
      runtime: measurement.results.runtime,
      reports: measurement.results.reports,
      workloads: measured ? performanceMetrics(measurement.results) : {},
      stages: measurement.stages,
    };
    const expected = {
      project: context.project,
      runId: context.runId,
      sourceSha: context.sourceSha,
      executionNonceSha256: context.executionNonceSha256,
      clickhouseUsername: clickhouseConfig.username,
    };
    const validation = evaluatePerformanceReport(report, thresholds, expected);
    report.status = validation.status;
    report.validation = validation;
    await runPerformanceStage("report-write", () => protectedWrite(options.output, report));
    process.stdout.write(
      `${JSON.stringify({ status: report.status, report: options.output, workloads: report.workloads })}\n`,
    );
    if (report.status !== "passed") process.exitCode = 1;
    return report;
  } finally {
    await client.close();
  }
}

export async function runRemotePerformanceCli(arguments_ = process.argv.slice(2)) {
  try {
    await runRemotePerformanceAcceptance(arguments_);
  } catch (error) {
    process.stderr.write(`${performanceFailureDiagnostic(error)}\n`);
    process.exitCode = 2;
  }
}

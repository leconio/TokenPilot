import { createHash } from "node:crypto";
import { resolve } from "node:path";

const PROJECT = /^tokenpilot-acceptance-(\d{14}-[0-9]+-[a-f0-9]{6})$/u;
const SOURCE_SHA = /^[a-f0-9]{40,64}$/u;

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function internalUrl(environment, name, expected) {
  const value = required(environment, name);
  if (value !== expected) throw new TypeError(`${name} must equal ${expected}`);
  return value;
}

function assertDatabaseUrl(raw) {
  const value = new URL(raw);
  if (
    !["postgres:", "postgresql:"].includes(value.protocol) ||
    value.hostname !== "postgres" ||
    (value.port !== "" && value.port !== "5432") ||
    value.pathname !== "/tokenpilot" ||
    value.search !== "" ||
    value.hash !== ""
  ) {
    throw new TypeError("DATABASE_URL must target the isolated postgres service");
  }
}

export function loadRemotePerformanceContext(
  environment = process.env,
  platform = process.platform,
) {
  if (platform !== "linux" || environment.REMOTE_DOCKER_ACCEPTANCE !== "1") {
    throw new TypeError("remote performance acceptance requires the guarded Linux runner");
  }
  if (environment.PERF_ISOLATED_STACK !== "true") {
    throw new TypeError("PERF_ISOLATED_STACK=true is required");
  }
  const project = required(environment, "ACCEPTANCE_PROJECT");
  const match = PROJECT.exec(project);
  if (match === null || project === "tokenpilot") {
    throw new TypeError("ACCEPTANCE_PROJECT is not a disposable acceptance project");
  }
  const runId = required(environment, "ACCEPTANCE_RUN_ID");
  if (match[1] !== runId) throw new TypeError("ACCEPTANCE_RUN_ID does not match the project");
  const sourceSha = required(environment, "SOURCE_SHA");
  if (!SOURCE_SHA.test(sourceSha)) {
    throw new TypeError("SOURCE_SHA is not a valid source binding digest");
  }
  const executionNonce = required(environment, "ACCEPTANCE_PERFORMANCE_NONCE");
  if (!/^[a-f0-9]{64}$/u.test(executionNonce)) {
    throw new TypeError("ACCEPTANCE_PERFORMANCE_NONCE must be a fresh 256-bit value");
  }
  const databaseUrl = required(environment, "DATABASE_URL");
  assertDatabaseUrl(databaseUrl);
  internalUrl(environment, "PERF_API_URL", "http://api:4000");
  internalUrl(environment, "CLICKHOUSE_URL", "http://clickhouse:8123");
  for (const name of [
    "PERF_APPLICATION_SLUG",
    "PERF_INGEST_API_KEY",
    "PERF_READ_API_KEY",
    "PERF_RUNTIME_API_KEY",
    "CLICKHOUSE_DATABASE",
    "CLICKHOUSE_USERNAME",
    "CLICKHOUSE_PASSWORD",
  ]) {
    required(environment, name);
  }
  if (environment.CLICKHOUSE_USERNAME === "default") {
    throw new TypeError("ClickHouse acceptance must use the application identity");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(environment.PERF_APPLICATION_SLUG)) {
    throw new TypeError("PERF_APPLICATION_SLUG is invalid");
  }
  return Object.freeze({
    project,
    runId,
    sourceSha,
    databaseUrl,
    applicationSlug: environment.PERF_APPLICATION_SLUG,
    executionNonceSha256: createHash("sha256").update(executionNonce).digest("hex"),
  });
}

export function resolvePerformanceOutput(value) {
  const output = resolve(value ?? "/backups/performance/report.json");
  if (!output.startsWith("/backups/performance/") || !output.endsWith(".json")) {
    throw new TypeError("performance output must be a JSON file under /backups/performance");
  }
  return output;
}

export function parseRemoteArguments(arguments_) {
  let output;
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] !== "--output" || arguments_[index + 1] === undefined || output) {
      throw new TypeError("Usage: remote-acceptance.mjs --output /backups/performance/FILE.json");
    }
    output = arguments_[++index];
  }
  return { output: resolvePerformanceOutput(output) };
}

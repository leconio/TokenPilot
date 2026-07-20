#!/usr/bin/env node

import { chmod, readFile, rename, writeFile } from "node:fs/promises";

const [environmentPath, runId, ingressPortText, liteLlmPortText] = process.argv.slice(2);
if (
  environmentPath === undefined ||
  runId === undefined ||
  ingressPortText === undefined ||
  liteLlmPortText === undefined
) {
  throw new TypeError("Usage: configure-environment.mjs ENV_FILE RUN_ID INGRESS_PORT LITELLM_PORT");
}
if (!/^\d{14}-\d+-[a-f0-9]{6}$/u.test(runId)) throw new TypeError("RUN_ID is invalid");
const ingressPort = Number(ingressPortText);
const liteLlmPort = Number(liteLlmPortText);
for (const [name, value] of [
  ["INGRESS_PORT", ingressPort],
  ["LITELLM_PORT", liteLlmPort],
]) {
  if (!Number.isInteger(value) || value < 20_000 || value > 60_999) {
    throw new RangeError(`${name} must be an isolated high port`);
  }
}
if (ingressPort === liteLlmPort) throw new RangeError("Acceptance ports must be distinct");

const imageSuffix = runId.replaceAll("-", "");
const acceptanceVersion = `0.2.0-acceptance.${runId.replaceAll("-", ".")}`;
const replacements = new Map([
  ["INSTANCE_ID", `acceptance-${runId}`],
  ["ENVIRONMENT", "test"],
  ["APP_TIMEZONE", "UTC"],
  ["WEB_BASE_URL", `http://127.0.0.1:${ingressPort}`],
  ["API_BASE_URL", `http://127.0.0.1:${ingressPort}`],
  ["FEATURE_USAGE_PIPELINE", "true"],
  ["FEATURE_MODEL_CATALOG", "true"],
  ["FEATURE_AIU", "true"],
  ["FEATURE_QUOTA", "true"],
  ["FEATURE_HARD_LIMIT", "true"],
  ["FEATURE_RECONCILIATION", "true"],
  ["AIU_ENABLED", "true"],
  ["AIU_MODE", "hard_limit"],
  ["CADDY_BIND_ADDRESS", "127.0.0.1"],
  ["HTTP_PORT", String(ingressPort)],
  ["LITELLM_DEMO_BIND_ADDRESS", "127.0.0.1"],
  ["LITELLM_DEMO_PORT", String(liteLlmPort)],
  ["CONTROL_PLANE_VERSION", acceptanceVersion],
  ["POSTGRES_IMAGE", `tokenpilot-acceptance-postgres:${imageSuffix}`],
  ["REDIS_IMAGE", `tokenpilot-acceptance-redis:${imageSuffix}`],
  ["MIGRATE_IMAGE", `tokenpilot-acceptance-migrate:${imageSuffix}`],
  ["API_IMAGE", `tokenpilot-acceptance-api:${imageSuffix}`],
  ["WORKER_IMAGE", `tokenpilot-acceptance-worker:${imageSuffix}`],
  ["SCHEDULER_IMAGE", `tokenpilot-acceptance-scheduler:${imageSuffix}`],
  ["WEB_IMAGE", `tokenpilot-acceptance-web:${imageSuffix}`],
  ["CADDY_IMAGE", `tokenpilot-acceptance-caddy:${imageSuffix}`],
  ["LITELLM_IMAGE", `tokenpilot-acceptance-litellm:${imageSuffix}`],
  ["FAKE_PROVIDER_IMAGE", `tokenpilot-acceptance-fake-provider:${imageSuffix}`],
  ["CLICKHOUSE_IMAGE", `tokenpilot-acceptance-clickhouse:${imageSuffix}`],
  ["CLICKHOUSE_DATABASE", `ai_control_acceptance_${imageSuffix}`],
  ["CLICKHOUSE_FRESH_REBUILD_ALLOWED", "true"],
  ["CLICKHOUSE_FRESH_REBUILD_OWNER", `acceptance:${runId}`],
  ["CLICKHOUSE_PULL_POLICY", "never"],
  ["PROMETHEUS_IMAGE", `tokenpilot-acceptance-prometheus:${imageSuffix}`],
  ["NODE_EXPORTER_IMAGE", `tokenpilot-acceptance-node-exporter:${imageSuffix}`],
  ["OBSERVABILITY_PULL_POLICY", "build"],
  ["RELEASE_TOOLING_IMAGE", `tokenpilot-acceptance-release-tooling:${imageSuffix}`],
]);

const source = await readFile(environmentPath, "utf8");
const seen = new Set();
const output = source.split("\n").map((line) => {
  const match = /^([A-Z][A-Z0-9_]*)=/u.exec(line);
  const key = match?.[1];
  if (key === undefined || !replacements.has(key)) return line;
  if (seen.has(key)) throw new TypeError(`Environment key is duplicated: ${key}`);
  seen.add(key);
  return `${key}=${replacements.get(key)}`;
});
for (const [key, value] of replacements) {
  if (!seen.has(key)) output.splice(-1, 0, `${key}=${value}`);
}
const temporaryPath = `${environmentPath}.configured`;
await writeFile(temporaryPath, output.join("\n"), { mode: 0o600 });
await chmod(temporaryPath, 0o600);
await rename(temporaryPath, environmentPath);
await chmod(environmentPath, 0o600);

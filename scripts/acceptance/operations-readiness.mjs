#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = (path) => readFileSync(resolve(root, path), "utf8");
const failures = [];

const requiredMetrics = [
  "ingestion_events_total",
  "ingestion_batches_total",
  "inbox_oldest_age_seconds",
  "settlement_events_total",
  "settlement_dlq_total",
  "provider_cost_unpriced_total",
  "aiu_unrated_total",
  "model_unmapped_total",
  "clickhouse_insert_failures_total",
  "clickhouse_outbox_backlog",
  "clickhouse_sink_lag_seconds",
  "aiu_rated_micros_total",
  "quota_check_total",
  "quota_reservations_active",
  "quota_reservation_expired_total",
  "quota_negative_balance_users",
  "reconciliation_runs_total",
  "reconciliation_diff_total",
  "reconciliation_last_success_timestamp",
];
const requiredAlerts = [
  "TokenPilotInboxOldestAge",
  "TokenPilotSettlementDLQIncreasing",
  "TokenPilotClickHouseDown",
  "TokenPilotClickHouseSinkLag",
  "TokenPilotClickHouseInsertFailures",
  "TokenPilotClickHouseStorageHigh",
  "TokenPilotReconciliationConsecutiveFailures",
  "TokenPilotProviderCostUnpricedRatio",
  "TokenPilotAiuUnratedRatio",
  "TokenPilotModelUnmapped",
  "TokenPilotQuotaNegativeBalance",
  "TokenPilotReservationExpirySpike",
  "TokenPilotRealtimeOfficialDelta",
];
const requiredOperationTopics = [
  "PostgreSQL unavailable",
  "Redis unavailable",
  "ClickHouse unavailable",
  "Fresh ClickHouse rebuild",
  "Connector heartbeat stale",
  "Unpriced Provider usage",
  "Unrated AIU usage",
  "Quota reservation expiry spike",
  "Reconciliation difference",
];
const scripts = [
  "scripts/operations/backup-clickhouse.sh",
  "scripts/operations/restore-clickhouse.sh",
  "scripts/operations/backup-redis.sh",
  "scripts/operations/restore-redis.sh",
];

const metrics = read("packages/shared/src/metrics.ts");
for (const name of requiredMetrics) {
  if (!metrics.includes(`ai_control_${name}`)) failures.push(`missing metric: ${name}`);
}
const alerts = read("deploy/observability/alerts.yml");
for (const name of requiredAlerts) {
  if (!alerts.includes(`alert: ${name}`)) failures.push(`missing alert: ${name}`);
}
const operationsGuide = read("docs/operations.md");
for (const topic of requiredOperationTopics) {
  if (!operationsGuide.includes(topic)) failures.push(`operations guide is missing: ${topic}`);
}
for (const match of alerts.matchAll(/^\s+runbook:\s+(.+)$/gmu)) {
  if (match[1] !== "docs/operations.md") failures.push(`stale runbook link: ${match[1]}`);
}
for (const script of scripts) {
  if (!existsSync(resolve(root, script))) failures.push(`missing operation script: ${script}`);
  else {
    try {
      execFileSync("bash", ["-n", resolve(root, script)], { stdio: "pipe" });
    } catch {
      failures.push(`invalid shell syntax: ${script}`);
    }
  }
}
const dashboard = JSON.parse(
  read("deploy/observability/grafana/dashboards/control-plane-overview.json"),
);
if (!Array.isArray(dashboard.panels) || dashboard.panels.length < 10) {
  failures.push("operations dashboard must contain at least ten panels");
}
for (const document of [
  "docs/operations.md",
  "docs/operations.zh-CN.md",
  "docs/deployment.md",
  "docs/deployment.zh-CN.md",
]) {
  if (!existsSync(resolve(root, document)))
    failures.push(`missing operation document: ${document}`);
}
try {
  execFileSync(process.execPath, ["scripts/quality/check-security-boundaries.mjs"], {
    cwd: root,
    stdio: "pipe",
  });
} catch {
  failures.push("security boundary check failed");
}

process.stdout.write(
  `${JSON.stringify({ status: failures.length === 0 ? "passed" : "failed", failures }, null, 2)}\n`,
);
if (failures.length > 0) process.exitCode = 1;

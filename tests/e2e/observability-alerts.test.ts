import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

describe("observability alert contracts", () => {
  it("keeps API current-state Gauges distinct from Worker event Counters", async () => {
    const apiMetrics = await readFile(new URL("apps/api/src/metrics.controller.ts", root), "utf8");
    const workerMetrics = await readFile(new URL("apps/worker/src/observability.ts", root), "utf8");
    const workerPlatformMetrics = await readFile(
      new URL("apps/worker/src/platform-metrics.ts", root),
      "utf8",
    );
    const metricContracts = await readFile(new URL("packages/shared/src/metrics.ts", root), "utf8");

    expect(apiMetrics).toContain('name: "ai_control_usage_processing_failures_current"');
    expect(apiMetrics).toContain('name: "ai_control_provider_cost_unpriced_current"');
    expect(apiMetrics).not.toContain('name: "ai_control_usage_processing_failures_total"');
    expect(apiMetrics).not.toContain('name: "ai_control_provider_cost_unpriced_total"');
    expect(workerMetrics).toContain('name: "ai_control_usage_processing_failures_total"');
    expect(workerPlatformMetrics).toContain("OPERATIONAL_METRICS.providerCostUnpriced");
    expect(metricContracts).toContain('"ai_control_provider_cost_unpriced_total"');
  });

  it("uses actionable runtime-configuration lag and a server-wide PostgreSQL ratio", async () => {
    const apiMetrics = await readFile(new URL("apps/api/src/metrics.controller.ts", root), "utf8");
    const alerts = await readFile(new URL("deploy/observability/alerts.yml", root), "utf8");

    expect(apiMetrics).toContain(
      "ai_control_runtime_configuration_connector_acknowledgement_lag_current",
    );
    expect(apiMetrics).toContain(
      "ai_control_runtime_configuration_acknowledgements_absent_current",
    );
    expect(apiMetrics).not.toContain("ai_control_policy_sdk_acknowledgement_lag_current");
    expect(apiMetrics).toContain("backend_type = 'client backend'");
    expect(apiMetrics).not.toContain("datname = current_database()");
    expect(alerts).toContain("TokenPilotRuntimeConfigurationAcknowledgementLag");
    expect(alerts).not.toContain("TokenPilotPolicySdkAcknowledgementLag");
  });

  it("self-scrapes Prometheus internally and tests threshold, absent, down, and healthy cases", async () => {
    const prometheus = await readFile(new URL("deploy/observability/prometheus.yml", root), "utf8");
    const alerts = await readFile(new URL("deploy/observability/alerts.yml", root), "utf8");
    const fixtures = await readFile(new URL("deploy/observability/alerts.test.yml", root), "utf8");

    expect(prometheus).toMatch(/job_name: prometheus[\s\S]*targets: \["prometheus:9090"\]/u);
    expect(prometheus).toMatch(
      /job_name: tokenpilot-worker[\s\S]*dns_sd_configs:[\s\S]*names: \["worker"\][\s\S]*type: A[\s\S]*port: 9464[\s\S]*refresh_interval: 5s/u,
    );
    expect(prometheus).not.toContain('targets: ["worker:9464"]');
    expect(prometheus).not.toMatch(/ports:/u);
    expect(alerts).toContain("TokenPilotConnectorMetricsMissing");
    expect(alerts).toContain("TokenPilotApiMetricsTargetMissing");
    expect(alerts).toContain("TokenPilotWorkerMetricsTargetMissing");
    expect(alerts).toContain("TokenPilotPrometheusSelfTargetMissing");
    expect(alerts).toContain("TokenPilotNodeExporterMetricsTargetMissing");
    expect(alerts.match(/absent\(/gu)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(fixtures).toContain("operational threshold branches fire");
    expect(fixtures).toContain("Connector absent branch");
    expect(fixtures).toContain("absent API target");
    expect(fixtures).toContain("absent Prometheus self target");
    expect(fixtures).toContain("absent Worker and node-exporter targets");
    expect(fixtures).toContain("down API, Worker, Prometheus, and node-exporter targets");
    expect(fixtures).toContain("published runtime configuration without any acknowledgement");
    expect(fixtures).toContain("healthy stable metrics do not fire any alert");
    expect(fixtures).toContain("current cost and AIU pipeline thresholds trigger their runbooks");
    expect(
      fixtures.match(
        /alertname: TokenPilot(?:Inbox|Settlement|ClickHouse|Reconciliation|Provider|Aiu|Model|Quota|Reservation|RuntimeConfiguration|Realtime)/gu,
      )?.length ?? 0,
    ).toBeGreaterThanOrEqual(13);
  });
});

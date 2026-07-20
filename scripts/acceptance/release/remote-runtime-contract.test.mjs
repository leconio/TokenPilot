import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const orchestrator = await readFile(new URL("../remote/run.sh", import.meta.url), "utf8");
const remoteLibrary = await readFile(new URL("../remote/lib.sh", import.meta.url), "utf8");
const diagnosticStages = await readFile(
  new URL("../remote/diagnostic-stages.sh", import.meta.url),
  "utf8",
);
const readinessStages = await readFile(
  new URL("../remote/readiness-stages.sh", import.meta.url),
  "utf8",
);
const runtimeObservability = await readFile(
  new URL("../remote/runtime-observability.sh", import.meta.url),
  "utf8",
);
const sustainedStability = await readFile(
  new URL("../remote/sustained-stability.sh", import.meta.url),
  "utf8",
);

test("result metadata binds the run interval and all mandatory datastores", () => {
  assert.match(orchestrator, /ACCEPTANCE_STARTED_AT=\$\(date -u/u);
  assert.match(remoteLibrary, /started_at=%s\\ncompleted_at=%s/u);
  assert.match(remoteLibrary, /datastores=postgresql,redis,clickhouse/u);
});

test("complete container logs are audited once per concrete container without retaining payloads", () => {
  assert.match(orchestrator, /container-log-audit\.txt/u);
  assert.match(orchestrator, /docker logs --timestamps "\$id"/u);
  assert.doesNotMatch(orchestrator, /docker logs[^\n]*--tail/u);
  assert.match(orchestrator, /com\.docker\.compose\.container-number/u);
  assert.match(orchestrator, /audit_worker_logs_before_scale_in/u);
  assert.match(orchestrator, /pre_scale_in_audited=%s final_audited=%s/u);
  assert.match(orchestrator, /sort \| uniq -d/u);
  assert.doesNotMatch(orchestrator, /for \(index=/u);
  assert.match(orchestrator, /grep -aFq -f "\$sensitive_patterns" "\$log"/u);
  assert.match(orchestrator, /sensitive_payload_leak=%s/u);
  assert.match(orchestrator, /rm -f -- "\$log"/u);
  assert.doesNotMatch(orchestrator, /runtime\/container-logs\.txt/u);
  assert.match(orchestrator, /mkdir -p "\$evidence\/runtime"/u);
  assert.match(orchestrator, /audit_containers/u);
});

test("isolated image builds retry bounded transient registry failures", () => {
  assert.match(readinessStages, /acceptance_build_isolated_images/u);
  assert.match(remoteLibrary, /acceptance_build_isolated_images/u);
  assert.match(remoteLibrary, /for attempt in 1 2 3/u);
  assert.match(remoteLibrary, /dc build --pull/u);
  assert.match(remoteLibrary, /sleep \$\(\(attempt \* 5\)\)/u);
});

test("remote acceptance includes a bounded sustained stability gate", () => {
  assert.match(diagnosticStages, /sustained-stability\.sh/u);
  assert.match(diagnosticStages, /STABILITY_DURATION_SECONDS=60/u);
  assert.match(diagnosticStages, /sustained-stability-backlog\.txt/u);
  assert.match(diagnosticStages, /inbox_outstanding=0/u);
  assert.match(diagnosticStages, /outbox_outstanding=0/u);
  assert.match(diagnosticStages, /inbox_dead_letter=0/u);
  assert.match(diagnosticStages, /outbox_dead_letter=0/u);
  assert.match(diagnosticStages, /active_dead_letter_events=0/u);
  for (const service of [
    "postgres",
    "redis",
    "clickhouse",
    "api",
    "worker",
    "scheduler",
    "web",
    "caddy",
    "fake-provider",
    "litellm",
    "prometheus",
    "node-exporter",
  ]) {
    assert.match(sustainedStability, new RegExp(`required_services=\\([^)]*${service}`, "su"));
  }
  assert.match(sustainedStability, /\$5 != "0"/u);
  assert.match(sustainedStability, /timeout --foreground --kill-after=5s/u);
  assert.match(sustainedStability, /STABILITY_EXPECTED_WORKER_REPLICAS/u);
  assert.match(sustainedStability, /expected_container_count/u);
  assert.match(sustainedStability, /printf "%.3f", \(candidate > prior \? candidate : prior\)/u);
});

test("worker scaling is boundary-gated and Prometheus discovers every replica", () => {
  const scaleTwo = diagnosticStages.indexOf("diagnostic_run worker-scale-two");
  const scaleTwoBoundary = diagnosticStages.indexOf(
    "record_runtime_boundary runtime-after-worker-scale-two",
  );
  const freshRebuild = diagnosticStages.indexOf("diagnostic_run clickhouse-fresh-rebuild");
  const scaleOne = diagnosticStages.indexOf("diagnostic_run worker-scale-one");
  const scaleOneBoundary = diagnosticStages.indexOf(
    "record_runtime_boundary runtime-after-worker-scale-one",
  );
  assert.ok(scaleTwo >= 0 && scaleTwo < scaleTwoBoundary && scaleTwoBoundary < freshRebuild);
  assert.ok(scaleOne > freshRebuild && scaleOne < scaleOneBoundary);
  assert.match(
    diagnosticStages,
    /if \[\[ "\$scale_two_passed" -eq 1 && "\$DIAGNOSTIC_RUNTIME_SAFE" -eq 1 \]\]/u,
  );
  assert.match(runtimeObservability, /audit_worker_logs_before_scale_in/u);
  assert.match(diagnosticStages, /DIAGNOSTIC_RUNTIME_SAFE=0/u);
  assert.match(
    runtimeObservability,
    /prometheus_targets_are_up "\$target_file" "\$expected_workers"/u,
  );
  assert.match(runtimeObservability, /ai_control_db_connections/u);
  assert.match(runtimeObservability, /ai_control_queue_depth/u);
  assert.match(runtimeObservability, /worker_metric_targets=%s/u);
  assert.match(runtimeObservability, /now - healthy_since >= 16/u);
});

test("Prometheus target validation requires the exact Worker replica count", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prometheus-target-contract-"));
  const targetPath = join(directory, "targets.json");
  const runtimePath = fileURLToPath(new URL("../remote/runtime-observability.sh", import.meta.url));
  const target = (job, instance) => ({ health: "up", labels: { job, instance } });
  const document = {
    data: {
      activeTargets: [
        target("prometheus", "prometheus:9090"),
        target("tokenpilot-api", "api:4000"),
        target("tokenpilot-worker", "10.0.0.10:9464"),
        target("tokenpilot-worker", "10.0.0.11:9464"),
        target("node-exporter", "node-exporter:9100"),
      ],
    },
  };
  try {
    await writeFile(targetPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
    await execute("bash", [
      "-c",
      'source "$1"; prometheus_targets_are_up "$2" 2',
      "bash",
      runtimePath,
      targetPath,
    ]);
    await assert.rejects(
      execute("bash", [
        "-c",
        'source "$1"; prometheus_targets_are_up "$2" 1',
        "bash",
        runtimePath,
        targetPath,
      ]),
    );
    document.data.activeTargets[2].health = "down";
    await writeFile(targetPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
    await assert.rejects(
      execute("bash", [
        "-c",
        'source "$1"; prometheus_targets_are_up "$2" 2',
        "bash",
        runtimePath,
        targetPath,
      ]),
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const runner = await readFile(new URL("../../run-release-test.mjs", import.meta.url), "utf8");
const orchestrator = await readFile(new URL("../remote/run.sh", import.meta.url), "utf8");
const backupRestore = await readFile(
  new URL("../remote/backup-restore-in-container.sh", import.meta.url),
  "utf8",
);
const remoteLibrary = await readFile(new URL("../remote/lib.sh", import.meta.url), "utf8");
const diagnosticStages = await readFile(
  new URL("../remote/diagnostic-stages.sh", import.meta.url),
  "utf8",
);
const readinessStages = await readFile(
  new URL("../remote/readiness-stages.sh", import.meta.url),
  "utf8",
);
const remoteStages = `${orchestrator}\n${readinessStages}`;
const realWebAcceptance = await readFile(
  new URL("../../../apps/web/e2e/real-stack-acceptance.spec.ts", import.meta.url),
  "utf8",
);
const applicationPreparation = await readFile(
  new URL("../remote/prepare-web-acceptance.mjs", import.meta.url),
  "utf8",
);
const dependencyOutageDrill = await readFile(
  new URL("../remote/dependency-outage-drill.sh", import.meta.url),
  "utf8",
);
const dependencyOutageProbe = await readFile(
  new URL("../remote/dependency-outage-probe.mjs", import.meta.url),
  "utf8",
);
const clickhouseEventVerification = await readFile(
  new URL("../remote/verify-clickhouse-event.mjs", import.meta.url),
  "utf8",
);
const reconciliationDrillShell = await readFile(
  new URL("../remote/reconciliation-drill.sh", import.meta.url),
  "utf8",
);
const reconciliationFaultDrill = await readFile(
  new URL("../remote/reconciliation-fault-drill.mjs", import.meta.url),
  "utf8",
);
const clickhouseFreshRemote = await readFile(
  new URL("../remote/clickhouse-fresh-rebuild.sh", import.meta.url),
  "utf8",
);
const clickhouseFreshRebuild = await readFile(
  new URL("./clickhouse-fresh-rebuild.mjs", import.meta.url),
  "utf8",
);
const clickhouseFreshRebuildTool = await readFile(
  new URL("../../release/clickhouse-fresh-rebuild.mjs", import.meta.url),
  "utf8",
);
const clickhouseFreshRebuildLibrary = await readFile(
  new URL("../../release/lib/clickhouse-fresh-rebuild.mjs", import.meta.url),
  "utf8",
);
const clickhouseFreshVerification = await readFile(
  new URL("../../release/lib/clickhouse-fresh-verification.mjs", import.meta.url),
  "utf8",
);
const clickhouseSchemaAcceptance = await readFile(
  new URL("../clickhouse-schema.sh", import.meta.url),
  "utf8",
);
const clickhouseSchemaLibrary = await readFile(
  new URL("../remote/clickhouse-schema-lib.sh", import.meta.url),
  "utf8",
);
const productionSnapshot = await readFile(
  new URL("../remote/production-snapshot.mjs", import.meta.url),
  "utf8",
);
const snapshotComparison = await readFile(
  new URL("../remote/compare-snapshots.mjs", import.meta.url),
  "utf8",
);
const maintenanceCompose = await readFile(
  new URL("../../../deploy/docker-compose.maintenance.yml", import.meta.url),
  "utf8",
);
const securityGates = await readFile(
  new URL("../remote/security-gates.sh", import.meta.url),
  "utf8",
);

test("remote release runner is pinned to the configured isolated host", () => {
  assert.match(runner, /process\.platform !== "linux"/u);
  assert.match(runner, /REMOTE_DOCKER_ACCEPTANCE/u);
  assert.match(runner, /RELEASE_ISOLATED_STACK/u);
  assert.match(runner, /process\.env\.ACCEPTANCE_HOST_ADDRESS/u);
  assert.match(runner, /127\.0\.0\.1/u);
});

test("remote release runner requires separate machine access planes", () => {
  for (const name of [
    "RELEASE_INGEST_API_KEY",
    "RELEASE_ADMIN_API_KEY",
    "RELEASE_RUNTIME_API_KEY",
  ]) {
    assert.match(runner, new RegExp(name, "u"));
  }
});

test("remote release runner executes both complete suites without partial arguments", () => {
  assert.match(runner, /current-stack\.remote\.test\.ts/u);
  assert.match(runner, /current-domain\.remote\.test\.ts/u);
  assert.match(runner, /--no-file-parallelism/u);
  assert.match(runner, /--testTimeout=420000/u);
  assert.match(runner, /does not permit partial-test arguments/u);
});

test("unified remote acceptance is production-protecting and fail-closed", () => {
  assert.match(orchestrator, /must not receive a production backup/u);
  assert.doesNotMatch(orchestrator, /production-clone|PRODUCTION_CLONE/u);
  assert.match(orchestrator, /production-snapshot\.mjs/u);
  assert.match(orchestrator, /compare-snapshots\.mjs/u);
  assert.match(orchestrator, /dc down --volumes --remove-orphans/u);
  assert.match(orchestrator, /acceptance_remove_project_resources "\$project"/u);
  assert.match(orchestrator, /acceptance_sanitize_evidence/u);
  assert.match(diagnosticStages, /security-gates\.sh/u);
  assert.ok(
    orchestrator.indexOf("production-before.json") <
      orchestrator.indexOf("run_pre_readiness_acceptance"),
  );
});

test("security scans reuse the proxy-fetched database without network access", () => {
  assert.match(securityGates, /image --cache-dir \/cache --download-db-only/u);
  assert.match(securityGates, /aquasec\/trivy@sha256:[0-9a-f]{64}/u);
  assert.match(securityGates, /anchore\/syft@sha256:[0-9a-f]{64}/u);
  assert.match(securityGates, /--network none/u);
  assert.equal(
    securityGates.match(/--skip-version-check --skip-vex-repo-update --offline-scan/gu)?.length,
    2,
  );
  assert.match(
    securityGates,
    /--name "\$project-trivy-repository"[\s\S]*?--volume "\$cache:\/cache"/u,
  );
  assert.match(
    securityGates,
    /--name "\$project-trivy-\$service"[\s\S]*?--volume "\$cache:\/cache"/u,
  );
  assert.match(securityGates, /image_archives=\$temporary\/image-archives/u);
  assert.equal(securityGates.match(/--volume "\$archive:\/image\.tar:ro"/gu)?.length, 2);
  assert.match(securityGates, /docker-archive:\/image\.tar/u);
  assert.match(securityGates, /--input "\/image\.tar"/u);
  assert.doesNotMatch(securityGates, /--volume "\$temporary:/u);
  assert.match(securityGates, /scanner_outputs=\$temporary\/scanner-outputs/u);
  assert.equal(securityGates.match(/--exit-code 0 --format json/gu)?.length, 2);
  assert.match(securityGates, /analyze-trivy-report\.mjs/u);
  assert.match(securityGates, /archive_image_identity/u);
  assert.match(securityGates, /archive_config_id=/u);
  assert.match(securityGates, /normalize_sbom/u);
  assert.match(securityGates, /JSON\.stringify\(input, null, 2\)/u);
  assert.match(securityGates, /declare -A canonical_image_service/u);
  assert.match(securityGates, /status=REUSED canonical_scope=/u);
  assert.match(securityGates, /finding_scopes=/u);
  assert.ok(
    securityGates.indexOf("canonical_image_service[$image_id]=$service") >
      securityGates.indexOf("scan_ready=1"),
  );
  assert.doesNotMatch(securityGates, /--output \/evidence\//u);
});

test("container orchestration is guarded before Docker and cannot select a workstation runtime", () => {
  assert.ok(
    remoteLibrary.indexOf('"$(uname -s)" != Linux') <
      remoteLibrary.indexOf("docker compose version"),
  );
  assert.ok(
    remoteLibrary.indexOf('addresses=" $(hostname -I 2>/dev/null) "') <
      remoteLibrary.indexOf("docker compose version"),
  );
  assert.match(remoteLibrary, /readonly ACCEPTANCE_ADDRESS=\$\{ACCEPTANCE_HOST_ADDRESS:-\}/u);
  assert.match(remoteLibrary, /ACCEPTANCE_HOST_ADDRESS must name/u); // Required host binding.
  assert.match(orchestrator, /acceptance_guard_host/u);
  assert.doesNotMatch(
    `${orchestrator}\n${remoteLibrary}`,
    /\b(?:podman|limactl|colima|lima|docker desktop)\b/iu,
  );
});

test("protected production inspection is Docker-read-only and compared exactly", () => {
  assert.match(remoteLibrary, /ACCEPTANCE_PRODUCTION_PROJECT:-tokenpilot/u);
  assert.match(
    productionSnapshot,
    /process\.env\.ACCEPTANCE_PRODUCTION_PROJECT \?\? "tokenpilot"/u,
  );
  assert.match(
    snapshotComparison,
    /process\.env\.ACCEPTANCE_PRODUCTION_PROJECT \?\? "tokenpilot"/u,
  );
  assert.match(clickhouseSchemaAcceptance, /ACCEPTANCE_PRODUCTION_PROJECT:-tokenpilot/u);
  assert.match(
    productionSnapshot,
    /const noun = kind === "container" \? \["ps", "-aq"\] : \[kind, "ls", "-q"\]/u,
  );
  assert.doesNotMatch(
    productionSnapshot,
    /docker\(\[\s*"(?:build|create|down|exec|kill|pause|pull|push|restart|rm|run|start|stop|tag|unpause|up|update)"/u,
  );
  assert.match(snapshotComparison, /isDeepStrictEqual\(before, after\)/u);
  assert.match(snapshotComparison, /delete document\.captured_at/u);
  assert.match(snapshotComparison, /state_sha256=\$\{stateFingerprint\}/u);
});

test("production state fingerprint ignores only capture time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "production-snapshot-contract-"));
  const beforePath = join(directory, "before.json");
  const afterPath = join(directory, "after.json");
  const comparisonPath = fileURLToPath(new URL("../remote/compare-snapshots.mjs", import.meta.url));
  const before = {
    schema_version: "current",
    captured_at: "2026-07-16T00:00:00.000Z",
    protected_project: "tokenpilot",
    host: "remote-207",
    containers: [{ service: "api", state: "running", restart_count: 0 }],
    protected_image_references: [{ reference: "api@sha256:example", image_id: "sha256:1" }],
    networks: [],
    volumes: [],
  };
  const after = { ...before, captured_at: "2026-07-16T00:05:00.000Z" };
  try {
    await Promise.all([
      writeFile(beforePath, `${JSON.stringify(before)}\n`, { mode: 0o600 }),
      writeFile(afterPath, `${JSON.stringify(after)}\n`, { mode: 0o600 }),
    ]);
    const result = await execute(process.execPath, [comparisonPath, beforePath, afterPath]);
    assert.match(result.stdout, /state_sha256=[a-f0-9]{64}/u);

    before.protected_project = "tokenpilot-current";
    after.protected_project = "tokenpilot-current";
    await Promise.all([
      writeFile(beforePath, `${JSON.stringify(before)}\n`, { mode: 0o600 }),
      writeFile(afterPath, `${JSON.stringify(after)}\n`, { mode: 0o600 }),
    ]);
    const namedResult = await execute(process.execPath, [comparisonPath, beforePath, afterPath], {
      env: { ...process.env, ACCEPTANCE_PRODUCTION_PROJECT: "tokenpilot-current" },
    });
    assert.match(namedResult.stdout, /state_sha256=[a-f0-9]{64}/u);

    after.containers = [{ ...after.containers[0], restart_count: 1 }];
    await writeFile(afterPath, `${JSON.stringify(after)}\n`, { mode: 0o600 });
    await assert.rejects(
      execute(process.execPath, [comparisonPath, beforePath, afterPath], {
        env: { ...process.env, ACCEPTANCE_PRODUCTION_PROJECT: "tokenpilot-current" },
      }),
      (error) => /runtime state changed/u.test(String(error.stderr)),
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("failure evidence is sanitized, finalized, and then hashed", () => {
  const finalizeStart = orchestrator.indexOf("finalize() {");
  const finalizeEnd = orchestrator.indexOf("\n}\n\ntrap finalize EXIT", finalizeStart);
  const finalize = orchestrator.slice(finalizeStart, finalizeEnd);
  assert.ok(finalizeStart >= 0 && finalizeEnd > finalizeStart);
  assert.ok(
    finalize.indexOf("acceptance_sanitize_evidence") < finalize.indexOf('rm -rf -- "$temporary"'),
  );
  assert.ok(
    finalize.indexOf('acceptance_write_result "$evidence/result.txt"') <
      finalize.indexOf('acceptance_hash_evidence "$evidence"'),
  );
  assert.match(finalize, /rm -f -- "\$evidence\/SHA256SUMS"[\s\S]*acceptance_write_result/u);
  assert.match(remoteLibrary, /sha256sum -- "\$file" \|\| exit 1/u);
  assert.match(remoteLibrary, /rm -f -- "\$evidence\/SHA256SUMS"/u);
  assert.match(remoteLibrary, /sensitive-payload-scan\.txt/u);
  assert.match(remoteLibrary, /"\$relative" != source-files\.sha256/u);
  assert.match(orchestrator, /Run the content-free real stack acceptance\./u);
});

test("evidence hashing rejects a failed digest and removes the partial manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evidence-hash-contract-"));
  const binaries = join(directory, "bin");
  const evidence = join(directory, "evidence");
  const libraryPath = fileURLToPath(new URL("../remote/lib.sh", import.meta.url));
  try {
    await Promise.all([mkdir(binaries, { mode: 0o700 }), mkdir(evidence, { mode: 0o700 })]);
    await Promise.all([
      writeFile(join(evidence, "result.txt"), "status=PASS\n", { mode: 0o600 }),
      writeFile(join(binaries, "sha256sum"), "#!/usr/bin/env sh\nexit 7\n", {
        mode: 0o700,
      }),
    ]);
    await assert.rejects(
      execute(
        "bash",
        ["-c", 'source "$1"; acceptance_hash_evidence "$2"', "bash", libraryPath, evidence],
        { env: { ...process.env, PATH: `${binaries}:${process.env.PATH}` } },
      ),
    );
    await assert.rejects(access(join(evidence, "SHA256SUMS")));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("the maintenance runtime receives no dependency proxy", () => {
  const runtimeEnvironment = maintenanceCompose
    .split("    environment:\n", 2)[1]
    ?.split("    command:", 1)[0];
  assert.ok(runtimeEnvironment !== undefined);
  assert.doesNotMatch(runtimeEnvironment, /(?:HTTP|HTTPS|ALL)_PROXY|(?:http|https|all)_proxy/u);
  assert.match(maintenanceCompose, /build:[\s\S]*HTTP_PROXY:[\s\S]*HTTPS_PROXY:/u);
});

test("remote acceptance uses only a fresh current PostgreSQL and ClickHouse stack", () => {
  assert.match(orchestrator, /provisions only a fresh isolated PostgreSQL and ClickHouse stack/u);
  assert.match(remoteStages, /scripts\/backup-postgres\.sh/u);
  assert.match(remoteStages, /--output \/backups/u);
  assert.match(remoteStages, /backup-restore-in-container\.sh/u);
  assert.match(remoteStages, /postgresql-migrate-second\.txt/u);
  assert.match(remoteStages, /clickhouse-schema\.sh/u);
  assert.match(clickhouseFreshRemote, /clickhouse-fresh-rebuild\.mjs/u);
  assert.match(remoteStages, /configure_clickhouse_fresh_ownership/u);
  assert.match(clickhouseFreshRemote, /clickhouse:fresh-rebuild:owner:/u);
  assert.doesNotMatch(
    `${orchestrator}\n${backupRestore}`,
    /production-clone|verify-postgresql-migration-transition|controlled forward migration/iu,
  );
  assert.match(backupRestore, /database_host" == postgres/u);
  assert.match(backupRestore, /database_name" == tokenpilot/u);
  assert.match(remoteStages, /tokenpilot_restore_/u);
  assert.doesNotMatch(`${remoteStages}\n${backupRestore}`, /ai_control_restore_/u);
  assert.equal(backupRestore.match(/db:migrate/gu)?.length, 2);
  assert.match(backupRestore, /restored current schema unexpectedly required migration/u);
});

test("ClickHouse schema conflicts are replaced only through fresh isolated storage", () => {
  assert.match(clickhouseSchemaAcceptance, /clickhouse-schema-lib\.sh/u);
  assert.match(clickhouseSchemaLibrary, /dc down -v --remove-orphans/u);
  assert.match(
    clickhouseSchemaLibrary,
    /containers volumes networks[\s\S]*project_resource_counts[\s\S]*containers=.*volumes=.*networks=/u,
  );
  for (const conflict of ["checksum-conflict", "orphan-conflict", "duplicate-conflict"]) {
    assert.match(
      clickhouseSchemaAcceptance,
      new RegExp(`recreate_isolated_storage ${conflict}`, "u"),
    );
    assert.match(
      clickhouseSchemaAcceptance,
      new RegExp(`install_fixture_from_empty_database ${conflict}`, "u"),
    );
  }
  assert.equal(clickhouseSchemaAcceptance.match(/TRUNCATE TABLE \$history_table/gu)?.length, 1);
  assert.equal(clickhouseSchemaAcceptance.match(/grep -Fq 'delete and recreate'/gu)?.length, 1);
  assert.equal(
    clickhouseSchemaAcceptance.match(/reject_conflict (?:checksum|orphaned|duplicate)/gu)?.length,
    3,
  );
  assert.match(
    clickhouseSchemaAcceptance,
    /recreate_isolated_storage fixture-to-current-schema[\s\S]*current-schema-empty-status/u,
  );
  assert.doesNotMatch(clickhouseSchemaAcceptance, /(?:history|orphan|duplicate)-recovered/u);
});

test("real integration suites receive the mandatory datastore configuration", () => {
  assert.match(readinessStages, /integration_environment=\(\)/u);
  assert.match(readinessStages, /if \[\[ "\$suite" != db \]\]/u);
  assert.match(
    readinessStages,
    /-e CLICKHOUSE_URL -e CLICKHOUSE_DATABASE -e CLICKHOUSE_USERNAME -e CLICKHOUSE_PASSWORD/u,
  );
  assert.match(
    readinessStages,
    /dc run --rm --no-deps[\s\S]*?"\$\{integration_environment\[@\]\}"/u,
  );
});

test("application preparation receives the loopback API before issuing application keys", () => {
  const apiUrl = readinessStages.indexOf('api_url="http://127.0.0.1:$ingress_port"');
  const releaseUrl = readinessStages.indexOf("export RELEASE_API_URL=$api_url", apiUrl);
  const preparation = readinessStages.indexOf("diagnostic_run application-preparation", apiUrl);
  assert.ok(apiUrl >= 0);
  assert.ok(releaseUrl > apiUrl);
  assert.ok(preparation > releaseUrl);
  assert.match(
    applicationPreparation,
    /AI_CONTROL_POLICY_LKG_PATH=\/var\/lib\/tokenpilot\/runtime-snapshot\.json/u,
  );
});

test("every required datastore outage fails closed and recovers the spooled event", () => {
  assert.match(diagnosticStages, /run_dependency_outage_drill/u);
  assert.match(dependencyOutageDrill, /for service in postgres redis clickhouse/u);
  assert.match(dependencyOutageDrill, /trap dependency_outage_cleanup EXIT/u);
  assert.match(dependencyOutageDrill, /dc start "\$service"/u);
  assert.match(dependencyOutageDrill, /"\$api_url\/health\/ready"/u);
  assert.match(dependencyOutageDrill, /full_stack_ready=%s/u);
  assert.match(dependencyOutageDrill, /wait_for_registry_request/u);
  assert.match(dependencyOutageDrill, /\[\[ "\$count" == 2 \]\]/u);
  assert.match(dependencyOutageDrill, /exactly two spooled Provider attempts/u);
  assert.match(dependencyOutageDrill, /verify-clickhouse-event\.mjs/u);
  assert.match(clickhouseEventVerification, /rowCount === 2/u);
  assert.match(dependencyOutageProbe, /health\/ready/u);
  assert.match(dependencyOutageProbe, /reports\/overview/u);
  assert.match(dependencyOutageProbe, /report\.status < 500/u);
  assert.match(dependencyOutageProbe, /v1\/chat\/completions/u);
});

test("remote reconciliation proves missing, duplicate, and amount repair to zero diffs", () => {
  assert.match(diagnosticStages, /run_reconciliation_acceptance/u);
  assert.match(
    diagnosticStages,
    /reconciliation_cleanup\(\)[\s\S]*?EVAL[\s\S]*?ARGV\[1\][\s\S]*?clickhouse:sink:pause "\$token"/u,
  );
  assert.match(
    diagnosticStages,
    /trap - EXIT[\s\S]*?reconciliation_cleanup[\s\S]*?return "\$reconciliation_status"/u,
  );
  assert.doesNotMatch(diagnosticStages, /reconciliation_cleanup\(\)[\s\S]*?if \[\[ "\$paused"/u);
  assert.match(reconciliationDrillShell, /real reconciliation detection and repair/u);
  assert.match(reconciliationDrillShell, /wait_outbox_count 0 "\$clickhouse_outbox_query"/u);
  assert.match(reconciliationDrillShell, /range_to\}\\n/u);
  assert.match(reconciliationFaultDrill, /missing projection replay did not reconcile to zero/u);
  assert.match(reconciliationFaultDrill, /DUPLICATE_PROJECTION/u);
  assert.match(reconciliationFaultDrill, /LEDGER_PROJECTION_MISSING/u);
  assert.match(reconciliationFaultDrill, /clickhouse-fresh-rebuild\.mjs/u);
  assert.match(reconciliationFaultDrill, /clear_isolated_database/u);
  assert.match(reconciliationFaultDrill, /controlled corruption repair did not reconcile to zero/u);
  assert.match(reconciliationFaultDrill, /resolution: "corrected"/u);
});

test("fresh ClickHouse repair is isolated, ownership-bound, and never retains an old schema", () => {
  assert.match(clickhouseFreshRebuild, /disposable-fresh-database/u);
  assert.match(clickhouseFreshRebuild, /obsolete_acceptance_/u);
  assert.match(clickhouseFreshRebuild, /historical_schema_retained !== false/u);
  assert.match(clickhouseFreshRebuildLibrary, /CLICKHOUSE_FRESH_REBUILD_ALLOWED/u);
  assert.match(clickhouseFreshRebuildTool, /clickhouse:fresh-rebuild:owner:/u);
  assert.match(clickhouseFreshRebuildTool, /dropDatabaseObjects/u);
  assert.match(clickhouseFreshRebuildTool, /cloneRetainedRows/u);
  assert.match(clickhouseFreshRebuildTool, /waitForProjectionCounts/u);
  assert.match(clickhouseFreshVerification, /actual\[table\] === count/u);
  assert.match(clickhouseFreshRebuildTool, /expectedProjectionDeliveryIds/u);
  assert.match(clickhouseFreshRebuildTool, /verifyProjectionDeliveryIds/u);
  assert.match(clickhouseFreshRebuildTool, /waitForAggregateSemantics/u);
  assert.match(clickhouseFreshVerification, /waitForAggregateSemantics/u);
  assert.match(clickhouseFreshRebuildTool, /aggregate_semantic_summaries/u);
  assert.doesNotMatch(clickhouseFreshRebuildTool, /previous_target|restored_target/u);
});

test("observability runtime images have one digest-locked build source", async () => {
  const lockSource = await readFile(
    new URL("../../../deploy/docker/Observability.Dockerfile", import.meta.url),
    "utf8",
  );
  assert.match(lockSource, /prom\/prometheus:v3\.13\.1@sha256:[a-f0-9]{64}/u);
  assert.match(lockSource, /prom\/node-exporter:[^@\s]+@sha256:[a-f0-9]{64}/u);
  assert.doesNotMatch(orchestrator, /seed_image 'prom\//u);
});

test("performance report is bound to a fresh evidence-scanned nonce", () => {
  assert.match(diagnosticStages, /ACCEPTANCE_PERFORMANCE_NONCE="\$\(openssl rand -hex 32\)"/u);
  assert.match(
    diagnosticStages,
    /printf '%s\\n' "\$ACCEPTANCE_PERFORMANCE_NONCE" >>"\$secret_patterns"/u,
  );
  assert.match(
    diagnosticStages,
    /performance_environment=\([\s\S]*?-e ACCEPTANCE_PERFORMANCE_NONCE/u,
  );
  assert.match(diagnosticStages, /performance_environment=\([\s\S]*?-e DATABASE_URL/u);
  assert.match(readinessStages, /export DATABASE_URL=\$database_url/u);
});

test("real Web acceptance covers healthy application flow and dependency error states", () => {
  assert.match(diagnosticStages, /REAL_STACK_SCENARIO=healthy/u);
  assert.match(diagnosticStages, /REAL_STACK_SCENARIO=clickhouse-outage/u);
  assert.match(diagnosticStages, /Web real-stack error state/u);
  assert.match(diagnosticStages, /web-error-\$browser_project-trace\.sha256/u);
});

test("real Web acceptance verifies application-scoped dynamic routing and reported usage", () => {
  assert.match(realWebAcceptance, /sendLiteLLMCompletion/u);
  assert.match(realWebAcceptance, /verifyReportedUsage/u);
  assert.match(realWebAcceptance, /environment!\.applicationSlug/u);
  assert.match(realWebAcceptance, /用户、字段、模型花费和 AIU/u);
  assert.doesNotMatch(realWebAcceptance, /\/(?:requests|base-models|subjects)/u);
  assert.doesNotMatch(realWebAcceptance, /describe\.configure\(\{ mode: "serial"/u);
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const orchestrator = await readFile(new URL("../remote/run.sh", import.meta.url), "utf8");
const batchDiagnostics = await readFile(
  new URL("../remote/batch-diagnostics.sh", import.meta.url),
  "utf8",
);
const diagnosticStages = await readFile(
  new URL("../remote/diagnostic-stages.sh", import.meta.url),
  "utf8",
);
const readinessStages = await readFile(
  new URL("../remote/readiness-stages.sh", import.meta.url),
  "utf8",
);

test("all remote stages collect independent failures before returning nonzero", async () => {
  assert.match(orchestrator, /source "\$script_directory\/batch-diagnostics\.sh"/u);
  assert.match(orchestrator, /source "\$script_directory\/diagnostic-stages\.sh"/u);
  assert.match(orchestrator, /source "\$script_directory\/readiness-stages\.sh"/u);
  assert.match(orchestrator, /diagnostic_batch_initialize "\$evidence"/u);
  assert.match(orchestrator, /run_pre_readiness_acceptance/u);
  assert.match(orchestrator, /run_post_readiness_diagnostics/u);
  assert.match(batchDiagnostics, /diagnostic-stages\.tsv/u);
  assert.match(batchDiagnostics, /diagnostic-summary\.txt/u);
  assert.match(batchDiagnostics, /\(\s*set -Eeuo pipefail\s*"\$@"\s*\)/u);
  assert.match(diagnosticStages, /return 80/u);
  for (const stage of [
    "dependency-install",
    "release-readiness",
    "operations-static",
    "compose-build",
    "compose-up",
    "postgresql-migrate-first",
    "postgresql-backup-restore",
  ]) {
    assert.match(readinessStages, new RegExp(`diagnostic_(?:run|block) ${stage}`, "u"));
  }
  assert.match(readinessStages, /for suite in db api worker/u);
  assert.match(readinessStages, /diagnostic_run "\$suite-integration"/u);
  assert.match(readinessStages, /diagnostic_block "\$suite-integration"/u);
  assert.match(readinessStages, /DIAGNOSTIC_RUNTIME_SAFE=\$isolation_ready/u);
  assert.match(diagnosticStages, /restore_clickhouse_after_web_outage/u);
  assert.match(diagnosticStages, /verify_diagnostic_runtime_boundary/u);
  assert.match(diagnosticStages, /GET clickhouse:sink:pause/u);
  assert.match(diagnosticStages, /clickhouse:fresh-rebuild:owner:/u);
  assert.match(diagnosticStages, /packages\/clickhouse\/dist\/cli\.js verify/u);
  assert.match(diagnosticStages, /the isolated runtime boundary is unsafe/u);
  const directory = await mkdtemp(join(tmpdir(), "batch-diagnostics-contract-"));
  const helper = fileURLToPath(new URL("../remote/batch-diagnostics.sh", import.meta.url));
  try {
    await execute("bash", [
      "-c",
      `set -Eeuo pipefail
acceptance_die() { printf '%s\\n' "$*" >&2; exit 1; }
source "$1"
diagnostic_batch_initialize "$2"
pass_stage() { printf 'pass\\n'; }
fail_stage() { printf 'failure seven\\n'; return 7; }
diagnostic_run pass "passing stage" "$2/pass.txt" pass_stage
diagnostic_run fail "failing stage" "$2/fail.txt" fail_stage
diagnostic_block blocked "blocked stage" "$2/blocked.txt" "missing prerequisite"
if diagnostic_batch_finish; then exit 99; fi
[[ "$DIAGNOSTIC_TOTAL" -eq 3 && "$DIAGNOSTIC_PASSED" -eq 1 ]]
[[ "$DIAGNOSTIC_FAILED" -eq 1 && "$DIAGNOSTIC_BLOCKED" -eq 1 ]]
grep -Fq $'fail\\tFAIL\\t7' "$2/diagnostic-stages.tsv"
grep -Fq $'blocked\\tBLOCKED\\t125' "$2/diagnostic-stages.tsv"
grep -Fxq 'status=FAIL' "$2/diagnostic-summary.txt"`,
      "bash",
      helper,
      directory,
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

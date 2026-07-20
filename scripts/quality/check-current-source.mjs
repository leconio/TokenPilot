#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const textExtensions = new Set([
  ".cjs",
  ".css",
  ".graphql",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mjs",
  ".prisma",
  ".py",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const canonicalRoots = ["connectors/", "examples/", "fixtures/", "packages/contracts/", "sdks/"];
const generationTerm = /\b(?:v(?:1|2)|phase\s*(?:1|2)|u(?:4|5|7|8|9))\b|一期|二期/iu;
const removedCommercialTerm = /\b(?:wallets?|invoices?)\b|钱包|发票|充值|商业账单/iu;
const unfinishedMarker = /\b(?:TODO|TBD)\b/iu;

const regressionGuardFiles = new Set([
  "apps/api/test/integration/ingestion.cases.ts",
  "apps/web/e2e/navigation-current.spec.ts",
  "apps/web/e2e/control-plane-resources.spec.ts",
  "apps/web/e2e/web-minimality.spec.ts",
  "fixtures/contracts/current/invalid/usage-confidence-deprecated-invoice.json",
  "fixtures/contracts/current/manifest.json",
  "packages/db/test/control-plane/migration-source.integration.test.ts",
  "packages/db/test/platform/cases/migration-seed.ts",
  "scripts/quality/check-current-documentation.mjs",
  "scripts/quality/check-current-source.mjs",
  "tests/e2e/performance-baseline.test.ts",
]);
const externalProtocolFiles = new Set([
  ".github/workflows/supply-chain.yml",
  "CODEX_IMPLEMENTATION_CHECKLIST.md",
  "apps/api/test/connections/connection.service.test.ts",
  "apps/api/test/runtime-configuration/runtime-access-snapshot.service.test.ts",
  "apps/api/test/runtime-configuration/runtime-configuration.service.test.ts",
  "apps/api/test/runtime/snapshot.service.test.ts",
  "apps/web/e2e/application-workflows.spec.ts",
  "apps/web/e2e/control-plane-mock-state.ts",
  "apps/web/e2e/real-stack-verification.ts",
  "apps/web/features/models/connection-create-dialog.tsx",
  "apps/web/features/models/connections-page.tsx",
  "connectors/litellm/tests/test_litellm_fallback_integration.py",
  "connectors/litellm/tests/test_runtime_policy.py",
  "deploy/docker-compose.yml",
  "deploy/docker/Caddy.Dockerfile",
  "deploy/docker/LiteLLM.Dockerfile",
  "deploy/docker/Observability.Dockerfile",
  "deploy/litellm/README.md",
  "deploy/litellm/config.demo.yaml",
  "docs/api.md",
  "docs/api.md",
  "docs/api.zh-CN.md",
  "docs/integration.md",
  "docs/integration.zh-CN.md",
  "examples/README.md",
  "examples/litellm-local/app.py",
  "examples/litellm-local/fake_provider.py",
  "examples/litellm-local/tests/test_example.py",
  "examples/fake-provider/server.mjs",
  "fixtures/contracts/current/invalid/runtime-snapshot-invalid-fallback-order.json",
  "fixtures/contracts/current/valid/runtime-snapshot.json",
  "packages/contracts/test/runtime-snapshot.test.ts",
  "packages/db/src/example-seed.ts",
  "packages/db/test/current-schema.integration.test.ts",
  "scripts/acceptance/release/remote-suite-contract.test.mjs",
  "scripts/acceptance/remote/dependency-outage-probe.mjs",
  "scripts/acceptance/remote/diagnostic-stages.sh",
  "scripts/acceptance/remote/prepare-web-acceptance.mjs",
  "scripts/acceptance/remote/run.sh",
  "scripts/acceptance/remote/runtime-observability.sh",
  "scripts/acceptance/remote/security-gates.sh",
  "scripts/release/check-release-readiness.mjs",
  "scripts/test-sdk-examples.mjs",
  "sdks/node/src/runtime/chat.ts",
  "sdks/node/src/runtime/provider-transport.ts",
  "sdks/node/test/runtime-chat.test.ts",
  "sdks/node/test/runtime-sdk.test.ts",
  "sdks/node/test/runtime-streaming.test.ts",
  "sdks/node/test/runtime-testkit.ts",
  "sdks/python/src/ai_control_sdk/runtime/provider_transport.py",
  "sdks/python/tests/runtime_testkit.py",
  "sdks/python/tests/test_runtime_chat.py",
  "sdks/python/tests/test_runtime_edges.py",
  "sdks/python/src/ai_control_sdk/runtime/chat.py",
  "sdks/python/tests/test_runtime_sdk.py",
  "tests/e2e/examples.test.ts",
  "tests/e2e/foundation.test.ts",
  "tests/e2e/litellm-config.test.ts",
]);

function repositoryFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
  })
    .toString()
    .split("\0")
    .filter((path) => path.length > 0 && existsSync(resolve(root, path)))
    .sort();
}

function allowsGenerationReference(path, line) {
  if (path === "pnpm-lock.yaml") return true;
  if (path.includes("/generated/")) return true;
  if (regressionGuardFiles.has(path)) return true;
  if (!externalProtocolFiles.has(path)) return false;
  return (
    line.includes("/v1") ||
    /\bv\d+\.\d+(?:\.\d+)?\b/iu.test(line) ||
    line.includes("github.com/caddyserver/caddy/v2") ||
    line.includes("api/v1/targets") ||
    line.includes("v1\\/chat\\/completions")
  );
}

const failures = [];
const files = repositoryFiles().filter((path) => textExtensions.has(extname(path)));
let canonicalFiles = 0;
for (const path of files) {
  const canonical = canonicalRoots.some((prefix) => path.startsWith(prefix));
  if (canonical) canonicalFiles += 1;
  if (generationTerm.test(path) && !allowsGenerationReference(path, path)) {
    failures.push(`${path}: path uses an internal product generation term`);
  }
  if (removedCommercialTerm.test(path) && !regressionGuardFiles.has(path)) {
    failures.push(`${path}: path uses a removed commercial-account concept`);
  }
  const content = readFileSync(resolve(root, path), "utf8");
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    const location = `${path}:${index + 1}`;
    if (generationTerm.test(line) && !allowsGenerationReference(path, line)) {
      failures.push(`${location}: uses an internal product generation term`);
    }
    if (removedCommercialTerm.test(line) && !regressionGuardFiles.has(path)) {
      failures.push(`${location}: uses a removed commercial-account concept`);
    }
    if (unfinishedMarker.test(line) && !regressionGuardFiles.has(path)) {
      failures.push(`${location}: contains an unfinished marker`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Current source scan failed (${failures.length}):\n- ${failures.join("\n- ")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Current source scan passed (${files.length} text files; ${canonicalFiles} Contract, SDK, Connector, fixture, and example files).\n`,
  );
}

#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const requiredDocuments = [
  "CHANGELOG.md",
  "README.md",
  "README.zh-CN.md",
  "docs/README.md",
  "docs/README.zh-CN.md",
  "docs/guide.md",
  "docs/guide.zh-CN.md",
  "docs/concepts.md",
  "docs/concepts.zh-CN.md",
  "docs/integration.md",
  "docs/integration.zh-CN.md",
  "docs/deployment.md",
  "docs/deployment.zh-CN.md",
  "docs/tutorial.md",
  "docs/tutorial.zh-CN.md",
  "docs/operations.md",
  "docs/operations.zh-CN.md",
  "docs/api.md",
  "docs/api.zh-CN.md",
  "docs/development.md",
  "docs/development.zh-CN.md",
];
const requiredExecutables = [
  "scripts/release/apply-feature-profile.sh",
  "scripts/release/clickhouse-fresh-rebuild.mjs",
  "scripts/release/generate-checksums.sh",
  "scripts/release/verify-checksums.sh",
  "scripts/acceptance/release/assert-postgres-authority.sh",
  "scripts/acceptance/release/clickhouse-fresh-rebuild.mjs",
  "scripts/acceptance/remote/run.sh",
  "scripts/acceptance/remote/security-gates.sh",
  "scripts/acceptance/remote/backup-restore-in-container.sh",
  "scripts/acceptance/remote/sustained-stability.sh",
];
const namingRoots = ["deploy/release", "docs", "scripts/release", "scripts/acceptance/release"];
const retiredGenerationName = /\b(?:v(?:1|2)|p(?:hase)\s*(?:1|2))\b/iu;

function containsRetiredProductGeneration(value) {
  return value.split(/\r?\n/u).some((line) => {
    if (!retiredGenerationName.test(line)) return false;
    return !line.includes("/v1/chat/completions") && !line.includes("v1\\/chat\\/completions");
  });
}

function parseArguments(arguments_) {
  const values = { strictGit: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--strict-git") {
      values.strictGit = true;
      continue;
    }
    if (argument === "--artifacts-dir") {
      const value = arguments_[index + 1];
      if (value === undefined) throw new TypeError(`${argument} requires a value`);
      values[argument.slice(2).replaceAll("-", "_")] = resolve(value);
      index += 1;
      continue;
    }
    throw new TypeError(`unknown argument: ${argument}`);
  }
  return values;
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else files.push(path);
  }
  return files;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const failures = [];
  const checks = [];
  const check = (name, passed, detail) => {
    checks.push({ name, passed, detail });
    if (!passed) failures.push(`${name}: ${detail}`);
  };

  try {
    execFileSync(process.execPath, [join(root, "scripts/check-version-consistency.mjs")], {
      cwd: root,
      stdio: "pipe",
    });
    check("exact build versions", true, "0.2.0");
  } catch (error) {
    check("exact build versions", false, error.stderr?.toString().trim() || "version check failed");
  }

  try {
    execFileSync(process.execPath, [join(root, "scripts/quality/check-source-layout.mjs")], {
      cwd: root,
      stdio: "pipe",
    });
    check("source layout", true, "formal paths and size limits");
  } catch (error) {
    check("source layout", false, error.stderr?.toString().trim() || "layout check failed");
  }

  try {
    execFileSync(
      process.execPath,
      [join(root, "scripts/quality/check-current-documentation.mjs")],
      {
        cwd: root,
        stdio: "pipe",
      },
    );
    check("current documentation", true, "routes, terminology, links, and script entries");
  } catch (error) {
    check(
      "current documentation",
      false,
      error.stderr?.toString().trim() || "documentation check failed",
    );
  }

  try {
    execFileSync(process.execPath, [join(root, "scripts/quality/check-current-source.mjs")], {
      cwd: root,
      stdio: "pipe",
    });
    check("current source", true, "canonical names, removed concepts, and unfinished markers");
  } catch (error) {
    check(
      "current source",
      false,
      error.stderr?.toString().trim() || "current source check failed",
    );
  }

  for (const document of requiredDocuments) {
    try {
      const content = await readFile(join(root, document), "utf8");
      check(`document ${document}`, content.trim().length > 0, "present");
    } catch {
      check(`document ${document}`, false, "missing");
    }
  }

  for (const executable of requiredExecutables) {
    try {
      const metadata = await stat(join(root, executable));
      check(`executable ${executable}`, (metadata.mode & 0o111) !== 0, "executable bit");
    } catch {
      check(`executable ${executable}`, false, "missing");
    }
  }

  for (const namingRoot of namingRoots) {
    for (const file of await collectFiles(join(root, namingRoot))) {
      const content = await readFile(file, "utf8");
      check(
        `current naming ${file.slice(root.length + 1)}`,
        !containsRetiredProductGeneration(content) && !retiredGenerationName.test(file),
        "contains only current business naming",
      );
    }
  }

  const migrations = await readdir(join(root, "packages/clickhouse/migrations"));
  const canonicalMigrations = migrations.filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort();
  const expectedMigrationNumbers = Array.from({ length: 23 }, (_, index) =>
    String(index + 1).padStart(4, "0"),
  );
  const actualMigrationNumbers = canonicalMigrations.map((name) => name.slice(0, 4));
  check(
    "canonical ClickHouse migrations",
    JSON.stringify(actualMigrationNumbers) === JSON.stringify(expectedMigrationNumbers),
    `${canonicalMigrations.length}/23 contiguous`,
  );

  const analyticsReportSources = (
    await Promise.all(
      ["analytics-repository.ts", "analytics-report-data.ts", "analytics-usage.ts"].map(
        async (file) => readFile(join(root, "apps/api/src/reports", file), "utf8"),
      ),
    )
  ).join("\n");
  for (const view of ["current_usage_events_raw", "current_rating_events"]) {
    check(
      `API query boundary ${view}`,
      analyticsReportSources.includes(view),
      "canonical view reference",
    );
  }

  const diffCheck = spawnSync("git", ["diff", "--check"], { cwd: root, encoding: "utf8" });
  check(
    "git diff",
    diffCheck.status === 0,
    diffCheck.stderr.trim() || diffCheck.stdout.trim() || "clean",
  );
  if (options.strictGit) {
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    check("git worktree", status.stdout.trim() === "", "clean worktree required");
  }

  const policy = JSON.parse(
    await readFile(join(root, "deploy/release/release-policy.json"), "utf8"),
  );
  check(
    "ClickHouse fresh-only rebuild policy",
    policy.clickhouse_rebuild?.mode === "fresh_only" &&
      policy.clickhouse_rebuild?.usage_authority === "postgresql" &&
      policy.clickhouse_rebuild?.retained_input === "pipeline_outbox" &&
      policy.clickhouse_rebuild?.schema_conflict_action === "clear_and_create_current_schema" &&
      policy.clickhouse_rebuild?.historical_schema_retained === false &&
      policy.clickhouse_rebuild?.ownership_marker_required === true,
    "clear conflicts, create only the current schema, replay retained PostgreSQL input",
  );
  const releaseAndAcceptanceText = (
    await Promise.all(
      (
        await Promise.all(
          ["scripts/release", "scripts/acceptance", "deploy/release"].map((directory) =>
            collectFiles(join(root, directory)),
          ),
        )
      )
        .flat()
        .filter((file) => !file.endsWith(".test.mjs"))
        .map((file) => readFile(file, "utf8")),
    )
  ).join("\n");
  const retiredReleasePatterns = new RegExp(
    [
      ["clickhouse", "shadow"].join("-"),
      ["clickhouse", "read", "boundary"].join("-"),
      ["analytics", "read", "targets"].join("_"),
      ["rollback", "window"].join("_"),
    ].join("|"),
    "iu",
  );
  check(
    "ClickHouse retired release flow absent",
    !retiredReleasePatterns.test(releaseAndAcceptanceText),
    "no retained-schema switch or compatibility-window tooling",
  );
  if (options.artifacts_dir !== undefined) {
    for (const artifact of ["repository.cdx.json", "repository.cdx.json.sha256", "SHA256SUMS"]) {
      try {
        await access(join(options.artifacts_dir, artifact));
        check(`release artifact ${artifact}`, true, "present");
      } catch {
        check(`release artifact ${artifact}`, false, "missing");
      }
    }
    const verification = spawnSync(
      join(root, "scripts/release/verify-checksums.sh"),
      [join(options.artifacts_dir, "SHA256SUMS")],
      { cwd: root, encoding: "utf8" },
    );
    check("release checksums", verification.status === 0, verification.stderr.trim() || "verified");
    try {
      const [sbom, checksumText] = await Promise.all([
        readFile(join(options.artifacts_dir, "repository.cdx.json")),
        readFile(join(options.artifacts_dir, "repository.cdx.json.sha256"), "utf8"),
      ]);
      const expected = checksumText.trim().split(/\s+/u)[0];
      const actual = createHash("sha256").update(sbom).digest("hex");
      check("SBOM checksum", /^[0-9a-f]{64}$/u.test(expected) && expected === actual, "SHA-256");
    } catch {
      check("SBOM checksum", false, "unreadable");
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        release: "0.2.0",
        decision: failures.length === 0 ? "pass" : "fail",
        failures,
        checks,
      },
      null,
      2,
    )}\n`,
  );
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "release readiness failed"}\n`);
  process.exitCode = 2;
});

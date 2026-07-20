import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const analyzer = new URL("../remote/analyze-trivy-report.mjs", import.meta.url);

const runAnalyzer = (scope, report, summary, expectedImageId) =>
  spawnSync(
    process.execPath,
    [analyzer.pathname, scope, report, summary, expectedImageId].filter(Boolean),
    {
      encoding: "utf8",
    },
  );

test("Trivy evidence aggregates every finding without retaining matched secret material", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "trivy-report-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = join(directory, "report.json");
  const summary = join(directory, "summary.json");
  const sentinel = "must-never-enter-sanitized-evidence";
  await writeFile(
    report,
    JSON.stringify({
      Results: [
        {
          Target: "deploy/Dockerfile",
          Vulnerabilities: [
            {
              VulnerabilityID: "CVE-2099-0001",
              Severity: "HIGH",
              PkgName: "sample",
              InstalledVersion: "1.0.0",
              FixedVersion: "1.0.1",
            },
          ],
          Misconfigurations: [
            {
              ID: "DS002",
              Severity: "CRITICAL",
              Title: "non-root required",
              Resolution: "set USER",
              CauseMetadata: { StartLine: 4, EndLine: 4 },
            },
          ],
          Secrets: [
            {
              RuleID: "generic-secret",
              Severity: "HIGH",
              Category: "General",
              Title: "secret material",
              StartLine: 8,
              EndLine: 8,
              Match: sentinel,
            },
          ],
        },
      ],
    }),
  );

  const result = runAnalyzer("repository", report, summary);
  assert.equal(result.status, 1);
  const contents = await readFile(summary, "utf8");
  const parsed = JSON.parse(contents);
  assert.equal(parsed.status, "FAIL");
  assert.equal(parsed.vulnerability_count, 1);
  assert.equal(parsed.misconfiguration_count, 1);
  assert.equal(parsed.secret_count, 1);
  assert.equal(parsed.findings.length, 3);
  assert.doesNotMatch(contents, new RegExp(sentinel, "u"));
  assert.doesNotMatch(contents, /"Match"/u);
});

test("Trivy evidence passes a valid report with no findings", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "trivy-report-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = join(directory, "report.json");
  const summary = join(directory, "summary.json");
  await writeFile(report, JSON.stringify({ Results: [{ Target: "repository" }] }));

  const result = runAnalyzer("runtime-api", report, summary);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(await readFile(summary, "utf8")), {
    scope: "runtime-api",
    status: "PASS",
    vulnerability_count: 0,
    misconfiguration_count: 0,
    secret_count: 0,
    findings: [],
  });
});

test("Trivy evidence rejects an empty result set and a mismatched image identity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "trivy-report-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const empty = join(directory, "empty.json");
  const image = join(directory, "image.json");
  await writeFile(empty, JSON.stringify({ Results: [] }));
  await writeFile(
    image,
    JSON.stringify({
      Metadata: { ImageID: `sha256:${"a".repeat(64)}` },
      Results: [{ Target: "runtime-image" }],
    }),
  );
  assert.equal(runAnalyzer("repository", empty, join(directory, "empty-summary.json")).status, 65);
  assert.equal(
    runAnalyzer(
      "runtime-api",
      image,
      join(directory, "image-summary.json"),
      `sha256:${"b".repeat(64)}`,
    ).status,
    65,
  );
});

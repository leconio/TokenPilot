#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const [scope, reportPath, summaryPath, expectedImageId] = process.argv.slice(2);

if (!/^[a-z0-9][a-z0-9-]*$/u.test(scope ?? "") || !reportPath || !summaryPath) {
  console.error("usage: analyze-trivy-report.mjs <scope> <report.json> <summary.json>");
  process.exit(64);
}

const cleanText = (value, maximum = 300) =>
  String(value ?? "")
    // eslint-disable-next-line no-control-regex -- scanner output is untrusted text.
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .slice(0, maximum);

const cleanLine = (value) => {
  const line = Number(value);
  return Number.isSafeInteger(line) && line > 0 ? line : null;
};

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (error) {
  console.error(`invalid Trivy JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(65);
}

if (!Array.isArray(report.Results)) {
  console.error("invalid Trivy JSON: Results must be an array");
  process.exit(65);
}
if (
  report.Results.length === 0 ||
  !report.Results.some((result) => typeof result?.Target === "string" && result.Target.length > 0)
) {
  console.error("invalid Trivy JSON: Results must identify at least one scanned target");
  process.exit(65);
}
if (expectedImageId !== undefined) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(expectedImageId)) {
    console.error("invalid expected image identity");
    process.exit(64);
  }
  if (report.Metadata?.ImageID !== expectedImageId) {
    console.error("Trivy report image identity does not match the immutable manifest");
    process.exit(65);
  }
}

const findings = [];
for (const result of report.Results) {
  const target = cleanText(result?.Target);
  for (const item of result?.Vulnerabilities ?? []) {
    if (!["HIGH", "CRITICAL"].includes(item?.Severity)) continue;
    findings.push({
      kind: "vulnerability",
      target,
      id: cleanText(item?.VulnerabilityID, 100),
      severity: item.Severity,
      package: cleanText(item?.PkgName, 150),
      installed_version: cleanText(item?.InstalledVersion, 150),
      fixed_version: cleanText(item?.FixedVersion, 150),
    });
  }
  for (const item of result?.Misconfigurations ?? []) {
    if (!["HIGH", "CRITICAL"].includes(item?.Severity)) continue;
    findings.push({
      kind: "misconfiguration",
      target,
      id: cleanText(item?.ID, 100),
      severity: item.Severity,
      title: cleanText(item?.Title),
      resolution: cleanText(item?.Resolution, 500),
      start_line: cleanLine(item?.CauseMetadata?.StartLine),
      end_line: cleanLine(item?.CauseMetadata?.EndLine),
    });
  }
  for (const item of result?.Secrets ?? []) {
    findings.push({
      kind: "secret",
      target,
      id: cleanText(item?.RuleID, 100),
      severity: ["HIGH", "CRITICAL"].includes(item?.Severity) ? item.Severity : "UNKNOWN",
      category: cleanText(item?.Category, 100),
      title: cleanText(item?.Title),
      start_line: cleanLine(item?.StartLine),
      end_line: cleanLine(item?.EndLine),
    });
  }
}

const count = (kind) => findings.filter((item) => item.kind === kind).length;
const summary = {
  scope,
  ...(expectedImageId === undefined ? {} : { image_id: expectedImageId }),
  status: findings.length === 0 ? "PASS" : "FAIL",
  vulnerability_count: count("vulnerability"),
  misconfiguration_count: count("misconfiguration"),
  secret_count: count("secret"),
  findings,
};

writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
process.exitCode = findings.length === 0 ? 0 : 1;

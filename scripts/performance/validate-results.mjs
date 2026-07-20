#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluatePerformanceReport } from "./report-validation.mjs";
import { loadRemotePerformanceContext } from "./remote-context.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function parse(arguments_) {
  let input;
  let thresholds = resolve(root, "scripts/performance/thresholds.json");
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    const value = arguments_[++index];
    if (name === "--input" && value !== undefined && input === undefined) input = resolve(value);
    else if (name === "--thresholds" && value !== undefined) thresholds = resolve(value);
    else throw new TypeError("Usage: validate-results.mjs --input REPORT [--thresholds FILE]");
  }
  if (input === undefined) throw new TypeError("--input is required");
  return { input, thresholds };
}

async function main() {
  const options = parse(process.argv.slice(2));
  const context = loadRemotePerformanceContext();
  const [report, thresholds] = await Promise.all(
    [options.input, options.thresholds].map(async (path) =>
      JSON.parse(await readFile(path, "utf8")),
    ),
  );
  const summary = evaluatePerformanceReport(report, thresholds, {
    project: context.project,
    runId: context.runId,
    sourceSha: context.sourceSha,
    executionNonceSha256: context.executionNonceSha256,
    clickhouseUsername: process.env.CLICKHOUSE_USERNAME,
  });
  if (report.status !== summary.status || report.validation?.status !== summary.status) {
    summary.failures.push("persisted report status does not match independent validation");
    summary.status = "failed";
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.status !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "validation failed"}\n`);
  process.exitCode = 2;
});

#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const source = async (path) => readFile(resolve(root, path), "utf8");
const checks = [];

function requireText(name, text, expected) {
  const missing = expected.filter((value) => !text.includes(value));
  if (missing.length > 0) throw new Error(`${name} missing: ${missing.join(", ")}`);
  checks.push(name);
}

async function main() {
  const [schema, keys, auth, clickhouse, apiSecurity, workerLogs, jobs, exports] =
    await Promise.all([
      source("packages/db/prisma/schema/19-applications.prisma"),
      source("packages/db/src/service-api-keys.ts"),
      source("apps/api/src/auth.ts"),
      source("packages/clickhouse/src/client/operations.ts"),
      source("apps/api/src/security.ts"),
      source("packages/shared/src/metrics.ts"),
      source("apps/api/src/jobs.service.ts"),
      source("apps/worker/src/usage-export.ts"),
    ]);
  requireText("hashed service keys", schema + keys, [
    "keyHash",
    '@map("key_hash")',
    "@db.Char(64)",
    "createHmac",
    "timingSafeEqual",
  ]);
  requireText("scope separation and rate limiting", auth, [
    '"runtime:read"',
    '"runtime:write"',
    "machineOnlyScopes",
    "adminOnlyScopes",
    "scopesUseSingleAccessPlane",
    "enforceRateLimit",
  ]);
  requireText("parameterized ClickHouse queries", clickhouse, [
    "query_params",
    "assertClickHouseIdentifier",
    'readonly: "1"',
    "query_id",
  ]);
  requireText("API and Worker log redaction", apiSecurity + workerLogs, [
    "redactLogArguments",
    "sanitizeOperationalAttributes",
    "[REDACTED]",
    "[OMITTED]",
  ]);
  requireText("bounded audited asynchronous exports", jobs + exports, [
    "export range cannot exceed 366 days",
    "reason: z.string().min(1).max(500)",
    "EXPORT_MAX_ROWS",
    "EXPORT_MAX_BYTES",
    "createWriteStream",
  ]);
  for (const forbidden of [
    '"subject_id"]',
    '"request_id"]',
    '"event_id"]',
    '"attempt_id"]',
    '"operation_id"]',
  ]) {
    if (workerLogs.includes(`labels: [${forbidden}`)) {
      throw new Error(`high-cardinality metric label is forbidden: ${forbidden}`);
    }
  }
  checks.push("low-cardinality metric labels");
  process.stdout.write(`${JSON.stringify({ status: "passed", checks }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "security validation failed"}\n`,
  );
  process.exitCode = 1;
});

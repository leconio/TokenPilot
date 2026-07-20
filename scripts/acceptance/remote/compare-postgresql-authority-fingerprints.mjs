#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

import {
  AUTHORITY_TABLES,
  authorityDigest,
  comparableFingerprint,
} from "./postgresql-authority-fingerprint.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const CAPTURED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function hasExactKeys(value, expected) {
  return isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}

export function validateAuthorityFingerprint(document) {
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    document.schema_version !== "current" ||
    document.fingerprint_version !== 1 ||
    document.table_count !== AUTHORITY_TABLES.length ||
    !HASH.test(document.authority_sha256 ?? "") ||
    !CAPTURED_AT.test(document.captured_at ?? "") ||
    !hasExactKeys(document, [
      "schema_version",
      "fingerprint_version",
      "captured_at",
      "table_count",
      "tables",
      "authority_sha256",
    ])
  ) {
    throw new TypeError("PostgreSQL authority fingerprint header is invalid");
  }
  const tables = document.tables;
  if (tables === null || typeof tables !== "object" || Array.isArray(tables)) {
    throw new TypeError("PostgreSQL authority fingerprint tables are invalid");
  }
  const names = Object.keys(tables).sort();
  if (!isDeepStrictEqual(names, [...AUTHORITY_TABLES])) {
    throw new TypeError("PostgreSQL authority fingerprint table set is incomplete");
  }
  for (const table of AUTHORITY_TABLES) {
    const entry = tables[table];
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !/^\d+$/u.test(entry.row_count ?? "") ||
      !HASH.test(entry.schema_sha256 ?? "") ||
      !HASH.test(entry.rows_sha256 ?? "") ||
      !hasExactKeys(entry, ["row_count", "watermark", "schema_sha256", "rows_sha256"])
    ) {
      throw new TypeError(`PostgreSQL authority table fingerprint is invalid: ${table}`);
    }
    if (entry.watermark !== null) {
      const watermark = entry.watermark;
      if (
        watermark === null ||
        typeof watermark !== "object" ||
        Array.isArray(watermark) ||
        typeof watermark.column !== "string" ||
        !Object.hasOwn(watermark, "minimum") ||
        !Object.hasOwn(watermark, "maximum") ||
        !(watermark.minimum === null || typeof watermark.minimum === "string") ||
        !(watermark.maximum === null || typeof watermark.maximum === "string") ||
        !hasExactKeys(watermark, ["column", "minimum", "maximum"])
      ) {
        throw new TypeError(`PostgreSQL authority watermark is invalid: ${table}`);
      }
    }
  }
  if (authorityDigest(document) !== document.authority_sha256) {
    throw new TypeError("PostgreSQL authority fingerprint digest does not match its contents");
  }
  return document;
}

export function differingTables(before, after) {
  return AUTHORITY_TABLES.filter(
    (table) => !isDeepStrictEqual(before.tables[table], after.tables[table]),
  );
}

export function compareAuthorityFingerprints(before, after) {
  validateAuthorityFingerprint(before);
  validateAuthorityFingerprint(after);
  if (!isDeepStrictEqual(comparableFingerprint(before), comparableFingerprint(after))) {
    const changed = differingTables(before, after);
    throw new Error(`PostgreSQL authority fingerprint changed: ${changed.join(", ")}`);
  }
  return { authority_sha256: before.authority_sha256, table_count: before.table_count };
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] === "--validate" && arguments_.length === 2) {
    const document = JSON.parse(await readFile(arguments_[1], "utf8"));
    validateAuthorityFingerprint(document);
    process.stdout.write(
      `PASS PostgreSQL authority fingerprint valid tables=${document.table_count} sha256=${document.authority_sha256}\n`,
    );
    return;
  }
  const [beforePath, afterPath] = arguments_;
  if (beforePath === undefined || afterPath === undefined || arguments_.length !== 2)
    throw new TypeError(
      "Usage: compare-postgresql-authority-fingerprints.mjs BEFORE AFTER | --validate FILE",
    );
  const [before, after] = await Promise.all(
    [beforePath, afterPath].map(async (path) => JSON.parse(await readFile(path, "utf8"))),
  );
  const result = compareAuthorityFingerprints(before, after);
  process.stdout.write(
    `PASS PostgreSQL authority fingerprint unchanged tables=${result.table_count} sha256=${result.authority_sha256}\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "PostgreSQL authority comparison failed"}\n`,
    );
    process.exitCode = 1;
  });
}

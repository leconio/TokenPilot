#!/usr/bin/env node

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";

const protectedProject = process.env.ACCEPTANCE_PRODUCTION_PROJECT ?? "tokenpilot";

if (!/^tokenpilot(?:-[a-z0-9]+)*$/u.test(protectedProject)) {
  throw new TypeError("The protected production project name is invalid");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

const [beforePath, afterPath] = process.argv.slice(2);
if (beforePath === undefined || afterPath === undefined) {
  throw new TypeError("Usage: compare-snapshots.mjs BEFORE AFTER");
}
const [before, after] = await Promise.all(
  [beforePath, afterPath].map(async (path) => JSON.parse(await readFile(path, "utf8"))),
);
for (const document of [before, after]) {
  if (
    document.schema_version !== "current" ||
    document.protected_project !== protectedProject ||
    !Array.isArray(document.containers) ||
    document.containers.length === 0 ||
    !Array.isArray(document.protected_image_references) ||
    document.protected_image_references.length === 0
  ) {
    throw new TypeError("Production snapshot is invalid");
  }
  delete document.captured_at;
}
if (!isDeepStrictEqual(before, after)) {
  process.stderr.write("Protected production identities or runtime state changed\n");
  process.exit(1);
}
const stateFingerprint = createHash("sha256")
  .update(JSON.stringify(canonicalize(before)))
  .digest("hex");
process.stdout.write(
  `PASS production container IDs, image IDs, state, health, restarts, ports, networks, and volumes unchanged state_sha256=${stateFingerprint}\n`,
);

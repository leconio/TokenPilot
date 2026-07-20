#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const generatedDirectory = resolve(root, "packages/contracts/generated");
const generatedPython = resolve(
  root,
  "connectors/litellm/src/ai_control_litellm/generated/contracts.py",
);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    }),
  );
  return nested.flat();
}

async function snapshot() {
  if (!(await stat(generatedPython)).isFile()) {
    throw new Error(`missing generated contract: ${relative(root, generatedPython)}`);
  }
  const files = [...(await filesUnder(generatedDirectory)), generatedPython].sort();
  return new Map(
    await Promise.all(
      files.map(async (file) => [
        relative(root, file),
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      ]),
    ),
  );
}

const before = await snapshot();
execFileSync("pnpm", ["generate:contracts"], { cwd: root, stdio: "inherit" });
const after = await snapshot();

const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
  (file) => before.get(file) !== after.get(file),
);
if (changed.length > 0) {
  process.stderr.write(
    `Generated contracts are stale; regenerate and commit:\n${changed.map((file) => `- ${file}`).join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`Generated contracts are stable (${after.size} files).\n`);
}

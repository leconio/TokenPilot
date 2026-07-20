#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const debtPath = resolve(repositoryRoot, "scripts/quality/source-size-debt.json");

const canonicalRootDirectories = new Set([
  ".github",
  "apps",
  "baselines",
  "connectors",
  "deploy",
  "docs",
  "examples",
  "fixtures",
  "packages",
  "scripts",
  "sdks",
  "tests",
]);

const canonicalRootFiles = new Set([
  ".dockerignore",
  ".editorconfig",
  ".env.example",
  ".gitattributes",
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  ".prettierignore",
  ".prettierrc.json",
  "CHANGELOG.md",
  "CODEX_IMPLEMENTATION_CHECKLIST.md",
  "CODEX_UNIFIED_MODEL_ROUTING_CHECKLIST.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "commitlint.config.mjs",
  "compose.yaml",
  "eslint.config.mjs",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.tools.json",
  "turbo.json",
  "vitest.config.ts",
]);

const ignoredPrefixes = [
  "apps/web/public/",
  "baselines/",
  "connectors/litellm/src/ai_control_litellm/generated/",
  "packages/contracts/generated/",
];
const ignoredNames = new Set(["CODEX_IMPLEMENTATION_CHECKLIST.md", "pnpm-lock.yaml", "uv.lock"]);
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
  ".scss",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

function repositoryFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repositoryRoot },
  ).toString();
  return output
    .split("\0")
    .filter((path) => path.length > 0 && existsSync(resolve(repositoryRoot, path)))
    .sort();
}

function lineLimit(path) {
  const extension = extname(path);
  if (path.includes("/__snapshots__/")) return undefined;
  if (ignoredNames.has(path.split("/").at(-1))) return undefined;
  if (ignoredPrefixes.some((prefix) => path.startsWith(prefix))) return undefined;
  if (path.includes("/generated/")) return undefined;
  if (path.includes("/migrations/") && path.endsWith(".sql")) return 600;
  if (extension === ".prisma") return 600;
  if (extension === ".md") return 800;
  if (extension === ".css" || extension === ".scss") return 500;
  if (
    path.includes("/test/") ||
    path.includes("/tests/") ||
    path.includes("/e2e/") ||
    /\.(spec|test)\.[cm]?[jt]sx?$/.test(path)
  ) {
    return 500;
  }
  if (path.startsWith("scripts/")) return 500;
  if ([".cjs", ".js", ".jsx", ".mjs", ".py", ".sh", ".ts", ".tsx"].includes(extension)) {
    return 400;
  }
  return undefined;
}

function linesIn(path) {
  const contents = readFileSync(resolve(repositoryRoot, path), "utf8");
  return contents === "" ? 0 : contents.split(/\r?\n/).length - Number(contents.endsWith("\n"));
}

function loadDebt() {
  const document = JSON.parse(readFileSync(debtPath, "utf8"));
  if (document.releaseDeadline !== "before-release" || !Array.isArray(document.files)) {
    throw new Error(
      "source-size debt manifest must target before-release and contain a files array",
    );
  }
  return new Map(
    document.files.map(({ path, maximumLines }) => {
      if (typeof path !== "string" || !Number.isInteger(maximumLines) || maximumLines < 1) {
        throw new Error(
          `invalid source-size debt entry: ${JSON.stringify({ path, maximumLines })}`,
        );
      }
      return [path, maximumLines];
    }),
  );
}

if (!existsSync(debtPath)) {
  throw new Error("missing scripts/quality/source-size-debt.json");
}

const files = repositoryFiles();
const fileSet = new Set(files);
const debt = loadDebt();
const failures = [];
const activeDebt = [];

const requiredShadcnFiles = [
  "apps/web/components.json",
  "apps/web/components/ui/badge.tsx",
  "apps/web/components/ui/button.tsx",
  "apps/web/components/ui/dialog.tsx",
  "apps/web/components/ui/input.tsx",
  "apps/web/components/ui/table.tsx",
  "apps/web/lib/utils.ts",
];
for (const path of requiredShadcnFiles) {
  if (!fileSet.has(path)) failures.push(`${path}: required shadcn/ui foundation file is missing`);
}

if (fileSet.has("apps/web/components.json")) {
  const shadcnConfig = JSON.parse(
    readFileSync(resolve(repositoryRoot, "apps/web/components.json"), "utf8"),
  );
  if (
    typeof shadcnConfig.style !== "string" ||
    shadcnConfig.style.length === 0 ||
    shadcnConfig.aliases?.ui !== "@/components/ui" ||
    shadcnConfig.tailwind?.css !== "app/globals.css" ||
    shadcnConfig.tailwind?.cssVariables !== true
  ) {
    failures.push("apps/web/components.json: shadcn aliases and Tailwind v4 ownership are invalid");
  }
}

for (const path of files) {
  const rootSegment = path.split("/", 1)[0];
  if (!path.includes("/") && !canonicalRootFiles.has(path)) {
    failures.push(`${path}: unexpected file at repository root`);
  } else if (path.includes("/") && !canonicalRootDirectories.has(rootSegment)) {
    failures.push(`${path}: unexpected top-level directory`);
  }

  const bytes = statSync(resolve(repositoryRoot, path)).size;
  if (bytes > 2 * 1024 * 1024) {
    failures.push(`${path}: ${bytes} bytes exceeds the 2 MiB tracked-file limit`);
  }

  const limit = lineLimit(path);
  if (limit === undefined || !textExtensions.has(extname(path))) continue;
  const lines = linesIn(path);
  const debtCeiling = debt.get(path);
  if (lines > limit && debtCeiling === undefined) {
    failures.push(`${path}: ${lines} lines exceeds the ${limit}-line limit`);
  } else if (lines > limit && lines > debtCeiling) {
    failures.push(`${path}: ${lines} lines grew past its debt ceiling of ${debtCeiling}`);
  } else if (lines > limit) {
    activeDebt.push(`${path} (${lines}/${debtCeiling}, target <= ${limit})`);
  } else if (debtCeiling !== undefined) {
    failures.push(
      `${path}: debt entry is stale because the file is now within its ${limit}-line limit`,
    );
  }
}

for (const path of debt.keys()) {
  if (!fileSet.has(path)) failures.push(`${path}: debt entry points to a missing file`);
}

if (activeDebt.length > 0) {
  process.stderr.write(
    `Source-size debt remaining before release:\n- ${activeDebt.join("\n- ")}\n`,
  );
}
if (failures.length > 0) {
  process.stderr.write(`Project structure check failed:\n- ${failures.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Project structure check passed (${files.length} files checked).\n`);
}

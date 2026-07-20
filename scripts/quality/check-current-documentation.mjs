#!/usr/bin/env node

import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const excludedDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
  "test-results",
]);
const topLevelDocuments = ["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md"];
const documentationTrees = ["docs", "examples"];
const readmeTrees = ["apps", "packages", "connectors", "deploy"];
const testTrees = ["apps", "packages", "connectors", "tests", "scripts"];
const currentWebRoutes = [
  "/dashboard",
  "/ai-units",
  "/costs",
  "/models",
  "/virtual-models",
  "/usage",
  "/users",
  "/user-groups",
  "/properties",
  "/reports",
  "/releases",
  "/connectors",
  "/audit",
  "/settings",
];
const removedWebRoutes = [
  "/billing",
  "/pricing",
  "/pricing/provider",
  "/deployments",
  "/dimensions",
  "/reconciliation",
  "/ai-units/ledger",
  "/ai-units/quotas",
  "/ai-units/rates",
  "/ai-units/subjects",
  "/models/base",
  "/models/logical",
  "/routing",
];
const retiredReferences = [
  "CODEX_PHASE2_AI_UNIT_CLICKHOUSE_UPGRADE_CHECKLIST.md",
  "docs/compatibility.md",
];
const generationTerm = /\b(?:v(?:1|2)|phase\s*(?:1|2)|u(?:4|5|7|8|9))\b|一期|二期/iu;
const commercialProductTerm =
  /\b(?:wallets?|invoices?|recharges?|refunds?)\b|钱包|发票|充值|商业账单|commercial[-\s]+(?:accounting|billing|charges?|pricing|retirement)|(?:billable|selling)\s+prices?/iu;
const unfinishedMarker = /\b(?:TODO|TBD)\b/iu;
const localScriptReference = /(?<![A-Za-z0-9_/-])(scripts\/[A-Za-z0-9._/-]+\.(?:js|mjs|py|sh))\b/gu;
const markdownLink = /!?\[[^\]]*\]\(([^)\n]+)\)/gu;
const pnpmCommand = /(?<![A-Za-z0-9_-])pnpm\s+([A-Za-z][A-Za-z0-9:_-]*)/gu;
const testTitle = /\b(?:describe|it|test)(?:\.[A-Za-z]+)?\(\s*["'`]([^"'`\n]+)["'`]/gu;

function displayPath(path) {
  return relative(root, path).replaceAll("\\", "/");
}

async function collectMarkdown(directory, readmeOnly = false) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdown(path, readmeOnly)));
    } else if (
      entry.isFile() &&
      (readmeOnly ? entry.name.toLowerCase() === "readme.md" : entry.name.endsWith(".md"))
    ) {
      files.push(path);
    }
  }
  return files;
}

async function collectTests(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTests(path)));
    } else if (
      entry.isFile() &&
      /(?:\.(?:test|spec)\.(?:[cm]?[jt]s|tsx?)|\.cases\.(?:[cm]?[jt]s|tsx?))$/u.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

function allowsTechnicalGenerationReference(line) {
  return line.includes("/v1/chat/completions") || /\bv1\.92\.0\b/iu.test(line);
}

function parseLocalLink(rawTarget) {
  const trimmed = rawTarget.trim();
  const target = trimmed.startsWith("<")
    ? trimmed.slice(1, trimmed.indexOf(">"))
    : trimmed.split(/\s+/u, 1)[0];
  if (
    target.length === 0 ||
    target.startsWith("#") ||
    target.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(target)
  ) {
    return undefined;
  }
  const withoutFragment = target.split("#", 1)[0].split("?", 1)[0];
  if (withoutFragment.length === 0) return undefined;
  try {
    return decodeURIComponent(withoutFragment.replaceAll("\\ ", " "));
  } catch {
    return withoutFragment;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const documents = [];
  for (const document of topLevelDocuments) documents.push(join(root, document));
  for (const tree of documentationTrees) {
    documents.push(...(await collectMarkdown(join(root, tree))));
  }
  for (const tree of readmeTrees) {
    documents.push(...(await collectMarkdown(join(root, tree), true)));
  }

  const uniqueDocuments = [...new Set(documents)].sort();
  const failures = [];
  const scriptReferences = new Set();
  const documentedPnpmCommands = new Set();

  for (const document of uniqueDocuments) {
    const content = await readFile(document, "utf8");
    const name = displayPath(document);
    for (const [index, line] of content.split(/\r?\n/u).entries()) {
      const location = `${name}:${index + 1}`;
      if (generationTerm.test(line) && !allowsTechnicalGenerationReference(line)) {
        failures.push(`${location} uses a product generation term`);
      }
      if (commercialProductTerm.test(line)) {
        failures.push(`${location} uses a removed commercial-account concept`);
      }
      if (unfinishedMarker.test(line)) {
        failures.push(`${location} contains an unfinished marker`);
      }
      for (const match of line.matchAll(localScriptReference)) scriptReferences.add(match[1]);
      for (const match of line.matchAll(pnpmCommand)) documentedPnpmCommands.add(match[1]);
    }
    for (const reference of retiredReferences) {
      if (content.includes(reference)) failures.push(`${name} references removed ${reference}`);
    }
    for (const match of content.matchAll(markdownLink)) {
      const target = parseLocalLink(match[1]);
      if (target === undefined) continue;
      const resolved = resolve(dirname(document), target);
      if (!(await exists(resolved))) {
        failures.push(`${name} has a broken local link: ${match[1]}`);
      }
    }
  }

  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const requiredScripts = {
    "acceptance:remote": "scripts/acceptance/remote/run.sh",
    "check:contracts": "node scripts/check-generated-contracts.mjs",
    "check:current": "node scripts/quality/check-current-source.mjs",
    "check:docs": "node scripts/quality/check-current-documentation.mjs && pnpm check:current",
    "check:structure": "node scripts/quality/check-source-layout.mjs",
  };
  for (const [name, command] of Object.entries(requiredScripts)) {
    if (packageJson.scripts?.[name] !== command) {
      failures.push(`package.json script ${name} must be ${JSON.stringify(command)}`);
    }
  }
  const pnpmBuiltins = new Set([
    "add",
    "audit",
    "dlx",
    "exec",
    "install",
    "list",
    "remove",
    "run",
    "update",
    "why",
  ]);
  for (const command of [...documentedPnpmCommands].sort()) {
    if (!pnpmBuiltins.has(command) && packageJson.scripts?.[command] === undefined) {
      failures.push(`documentation references missing pnpm script: ${command}`);
    }
  }
  for (const command of Object.values(packageJson.scripts ?? {})) {
    for (const match of command.matchAll(localScriptReference)) scriptReferences.add(match[1]);
  }
  for (const reference of [...scriptReferences].sort()) {
    if (!(await exists(join(root, reference))))
      failures.push(`missing script entry target: ${reference}`);
  }

  const webReadme = await readFile(join(root, "apps/web/README.md"), "utf8");
  for (const route of currentWebRoutes) {
    if (!webReadme.includes(`\`/apps/:slug${route}\``)) {
      failures.push(`apps/web/README.md is missing current route ${route}`);
    }
  }
  for (const route of removedWebRoutes) {
    if (webReadme.includes(`\`/apps/:slug${route}\``)) {
      failures.push(`apps/web/README.md still lists removed route ${route}`);
    }
  }
  if (!/match all/iu.test(webReadme) || !/match any/iu.test(webReadme)) {
    failures.push("apps/web/README.md must describe both filter combination modes");
  }

  const tests = [];
  for (const tree of testTrees) tests.push(...(await collectTests(join(root, tree))));
  let testTitleCount = 0;
  for (const testFile of [...new Set(tests)].sort()) {
    const content = await readFile(testFile, "utf8");
    const name = displayPath(testFile);
    if (generationTerm.test(name) || commercialProductTerm.test(name)) {
      failures.push(`${name} uses a removed product concept in its path`);
    }
    for (const match of content.matchAll(testTitle)) {
      testTitleCount += 1;
      const title = match[1];
      if (
        (generationTerm.test(title) && !allowsTechnicalGenerationReference(title)) ||
        commercialProductTerm.test(title) ||
        unfinishedMarker.test(title)
      ) {
        failures.push(`${name} has a stale user-visible test title: ${title}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error(`Current documentation check failed (${failures.length}):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Current documentation check passed (${uniqueDocuments.length} documents, ${scriptReferences.size} script targets, ${testTitleCount} test titles).`,
  );
}

await main();

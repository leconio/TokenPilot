#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const semanticVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ignoredDirectories = new Set([
  ".tokenpilot",
  ".git",
  ".mypy_cache",
  ".next",
  ".pytest_cache",
  ".ruff_cache",
  ".runtime",
  ".sbom",
  ".trivy-cache",
  ".turbo",
  ".venv",
  "__pycache__",
  "artifacts",
  "backups",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

async function collectPackageFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectPackageFiles(absolute)));
    else if (entry.name === "package.json") files.push(absolute);
  }
  return files;
}

function requireMatch(text, pattern, label) {
  const match = text.match(pattern);
  if (match?.[1] === undefined) throw new Error(`Unable to read ${label}`);
  return match[1];
}

const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const releaseVersion = rootPackage.version;
if (!semanticVersion.test(releaseVersion))
  throw new Error(`Invalid root SemVer: ${releaseVersion}`);

const failures = [];
for (const file of await collectPackageFiles(root)) {
  const manifest = JSON.parse(await readFile(file, "utf8"));
  if (manifest.version !== releaseVersion) {
    failures.push(
      `${relative(root, file)} has ${String(manifest.version)}; expected ${releaseVersion}`,
    );
  }
}

for (const pyproject of ["connectors/litellm/pyproject.toml", "sdks/python/pyproject.toml"]) {
  const text = await readFile(join(root, pyproject), "utf8");
  const version = requireMatch(text, /^version\s*=\s*"([^"]+)"/m, `${pyproject} version`);
  if (version !== releaseVersion)
    failures.push(`${pyproject} has ${version}; expected ${releaseVersion}`);
}

for (const lockFile of ["connectors/litellm/uv.lock", "sdks/python/uv.lock"]) {
  const text = await readFile(join(root, lockFile), "utf8");
  const version = requireMatch(text, /^version\s*=\s*"([^"]+)"/m, `${lockFile} project version`);
  if (version !== releaseVersion) {
    failures.push(`${lockFile} has ${version}; expected ${releaseVersion}`);
  }
}

const releasePolicy = JSON.parse(
  await readFile(join(root, "deploy/release/release-policy.json"), "utf8"),
);
if (releasePolicy.release !== releaseVersion) {
  failures.push(
    `deploy/release/release-policy.json has ${String(releasePolicy.release)}; expected ${releaseVersion}`,
  );
}

for (const composeFile of [
  "deploy/docker-compose.yml",
  "deploy/docker-compose.clickhouse.yml",
  "deploy/docker-compose.maintenance.yml",
]) {
  const text = await readFile(join(root, composeFile), "utf8");
  const defaults = [...text.matchAll(/CONTROL_PLANE_VERSION:-([^}]+)/gu)].map((match) => match[1]);
  if (defaults.length === 0) failures.push(`${composeFile} has no release image default`);
  for (const value of defaults) {
    if (value !== releaseVersion) {
      failures.push(`${composeFile} has image default ${value}; expected ${releaseVersion}`);
    }
  }
}

const liteLLMDemoCompose = "deploy/docker-compose.litellm-demo.yml";
const liteLLMDemoText = await readFile(join(root, liteLLMDemoCompose), "utf8");
const fakeProviderVersion = requireMatch(
  liteLLMDemoText,
  /\$\{FAKE_PROVIDER_IMAGE:-tokenpilot-fake-provider:([^}]+)\}/u,
  `${liteLLMDemoCompose} fake-provider image default`,
);
if (fakeProviderVersion !== releaseVersion) {
  failures.push(
    `${liteLLMDemoCompose} has fake-provider image default ${fakeProviderVersion}; expected ${releaseVersion}`,
  );
}

for (const dockerfile of ["deploy/docker/Dockerfile", "deploy/docker/LiteLLM.Dockerfile"]) {
  const text = await readFile(join(root, dockerfile), "utf8");
  const version = requireMatch(
    text,
    /^ARG CONTROL_PLANE_VERSION=([^\s]+)$/m,
    `${dockerfile} release argument`,
  );
  if (version !== releaseVersion) {
    failures.push(`${dockerfile} has ${version}; expected ${releaseVersion}`);
  }
}

const exampleEnvironment = await readFile(join(root, ".env.example"), "utf8");
const exampleVersion = requireMatch(
  exampleEnvironment,
  /^CONTROL_PLANE_VERSION=([^\s]+)$/m,
  "example environment release",
);
if (exampleVersion !== releaseVersion) {
  failures.push(`.env.example has ${exampleVersion}; expected ${releaseVersion}`);
}

if (
  process.env.CONTROL_PLANE_VERSION !== undefined &&
  process.env.CONTROL_PLANE_VERSION !== releaseVersion
) {
  failures.push(
    `CONTROL_PLANE_VERSION environment value ${process.env.CONTROL_PLANE_VERSION} does not match ${releaseVersion}`,
  );
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Version consistency OK: ${releaseVersion}`);

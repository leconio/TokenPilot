import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const rootComposeFile = "compose.yaml";
const composeFiles = [
  "deploy/docker-compose.yml",
  "deploy/docker-compose.dev.yml",
  "deploy/docker-compose.clickhouse.yml",
  "deploy/docker-compose.external-gateway.yml",
  "deploy/docker-compose.litellm-demo.yml",
  "deploy/docker-compose.maintenance.yml",
];

function fail(file, message) {
  throw new Error(`${file}: ${message}`);
}

function serviceNames(file, source) {
  const servicesStart = source.search(/^services:\s*$/mu);
  if (servicesStart < 0) fail(file, "missing top-level services mapping");
  const block = source.slice(servicesStart + source.slice(servicesStart).indexOf("\n") + 1);
  const nextTopLevel = block.search(/^[a-z][a-z0-9_-]*:\s*(?:#.*)?$/mu);
  const services = nextTopLevel < 0 ? block : block.slice(0, nextTopLevel);
  return [...services.matchAll(/^ {2}([a-z][a-z0-9_-]*):\s*(?:#.*)?$/gmu)].map((match) => match[1]);
}

function validateSource(file, source) {
  if (source.includes("\t")) fail(file, "tabs are forbidden in YAML indentation");
  if (!source.endsWith("\n")) fail(file, "must end with a newline");
  for (const [index, line] of source.split("\n").entries()) {
    if (/^ +/u.test(line) && (line.match(/^ */u)?.[0].length ?? 0) % 2 !== 0) {
      fail(file, `line ${index + 1} uses non-two-space indentation`);
    }
  }

  const anchors = new Set([...source.matchAll(/&([a-z][a-z0-9_-]*)/gu)].map((match) => match[1]));
  for (const match of source.matchAll(/\*([a-z][a-z0-9_-]*)/gu)) {
    if (!anchors.has(match[1])) fail(file, `alias *${match[1]} has no document-local anchor`);
  }
  const interpolations = [...source.matchAll(/\$\{([^}\n]+)\}/gu)];
  for (const match of interpolations) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?::[-+?].*)?$/u.test(match[1])) {
      fail(file, `invalid environment interpolation \${${match[1]}}`);
    }
  }
  if ((source.match(/\$\{/gu) ?? []).length !== interpolations.length) {
    fail(file, "unbalanced environment interpolation");
  }

  const services = serviceNames(file, source);
  if (services.length === 0) fail(file, "services mapping is empty");
  if (new Set(services).size !== services.length) fail(file, "contains duplicate service keys");
  return services;
}

const sources = new Map(
  await Promise.all(
    composeFiles.map(async (file) => [file, await readFile(resolve(root, file), "utf8")]),
  ),
);
const rootCompose = await readFile(resolve(root, rootComposeFile), "utf8");
if (!/^name: tokenpilot$/mu.test(rootCompose)) {
  fail(rootComposeFile, "must set the default project name to tokenpilot");
}
if (!/^include:\s*\n\s+- path: \.\/deploy\/docker-compose\.yml$/mu.test(rootCompose)) {
  fail(rootComposeFile, "must include the canonical deployment definition");
}
const environmentExample = await readFile(resolve(root, ".env.example"), "utf8");
for (const required of [
  "POSTGRES_PASSWORD",
  "CLICKHOUSE_BOOTSTRAP_PASSWORD",
  "CLICKHOUSE_MIGRATION_PASSWORD",
  "CLICKHOUSE_PASSWORD",
  "API_KEY_PEPPER",
]) {
  if (!new RegExp(`^${required}=.+$`, "mu").test(environmentExample)) {
    fail(".env.example", `missing required value ${required}`);
  }
}
const services = new Map(
  [...sources].map(([file, source]) => [file, validateSource(file, source)]),
);
const baseServices = new Set(services.get("deploy/docker-compose.yml"));
for (const required of [
  "postgres",
  "redis",
  "clickhouse",
  "clickhouse-migrate",
  "migrate",
  "api",
  "worker",
  "scheduler",
  "web",
]) {
  if (!baseServices.has(required)) fail("deploy/docker-compose.yml", `missing ${required} service`);
}
for (const service of services.get("deploy/docker-compose.dev.yml")) {
  if (!baseServices.has(service)) {
    fail("deploy/docker-compose.dev.yml", `override references unknown service ${service}`);
  }
}
for (const service of services.get("deploy/docker-compose.external-gateway.yml")) {
  if (!baseServices.has(service)) {
    fail(
      "deploy/docker-compose.external-gateway.yml",
      `override references unknown service ${service}`,
    );
  }
}

process.stdout.write(
  `Compose source checks passed (${composeFiles.length} implementation files plus root entry).\n`,
);

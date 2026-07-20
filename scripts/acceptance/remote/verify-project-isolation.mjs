#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import os from "node:os";

const [project, ingressPort, liteLlmPort, imageManifest] = process.argv.slice(2);
const designatedAddress = process.env.ACCEPTANCE_HOST_ADDRESS;
if (
  project === undefined ||
  ingressPort === undefined ||
  liteLlmPort === undefined ||
  imageManifest === undefined
) {
  throw new TypeError(
    "Usage: verify-project-isolation.mjs PROJECT INGRESS_PORT LITELLM_PORT IMAGE_MANIFEST",
  );
}
if (
  process.platform !== "linux" ||
  process.env.REMOTE_DOCKER_ACCEPTANCE !== "1" ||
  !designatedAddress ||
  !Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .some((entry) => entry.address === designatedAddress)
) {
  throw new Error("Project verification is restricted to the authorized remote host");
}
if (!/^tokenpilot-acceptance-\d{14}-\d+-[a-f0-9]{6}$/u.test(project)) {
  throw new TypeError("The isolated project name is invalid");
}

function docker(arguments_) {
  return execFileSync("docker", arguments_, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

const ids = docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`]).split(
  "\n",
);
if (ids.length === 0 || ids[0] === "") throw new Error("The isolated project has no containers");
const containers = JSON.parse(docker(["inspect", ...ids]));
const expectedServices = [
  "api",
  "caddy",
  "clickhouse",
  "clickhouse-migrate",
  "fake-provider",
  "litellm",
  "migrate",
  "node-exporter",
  "postgres",
  "prometheus",
  "redis",
  "scheduler",
  "web",
  "worker",
];
const byService = new Map();
const oneShotServices = new Set(["clickhouse-migrate", "migrate"]);
for (const container of containers) {
  const labels = container.Config?.Labels ?? {};
  if (labels["com.docker.compose.project"] !== project) throw new Error("Project label mismatch");
  const service = labels["com.docker.compose.service"];
  if (typeof service !== "string" || byService.has(service)) {
    throw new Error("Each isolated service must have exactly one container");
  }
  byService.set(service, container);
  const state = container.State ?? {};
  if (oneShotServices.has(service)) {
    if (state.Status !== "exited" || state.ExitCode !== 0) {
      throw new Error(`One-shot service ${service} did not exit successfully`);
    }
  } else if (state.Status !== "running" || state.Health?.Status !== "healthy") {
    throw new Error(`Long-running service ${service} is not running and healthy`);
  }
  if (container.HostConfig?.ReadonlyRootfs !== true) {
    throw new Error(`Service ${service} has a writable root filesystem`);
  }
  const user = String(container.Config?.User ?? "").split(":", 1)[0];
  if (user === "" || user === "0" || user === "root") {
    throw new Error(`Service ${service} does not have an explicit non-root identity`);
  }
  if (!(container.HostConfig?.CapDrop ?? []).includes("ALL")) {
    throw new Error(`Service ${service} does not drop all capabilities`);
  }
  if (
    !(container.HostConfig?.SecurityOpt ?? []).some((value) => value.includes("no-new-privileges"))
  ) {
    throw new Error(`Service ${service} does not enforce no-new-privileges`);
  }
  for (const mount of container.Mounts ?? []) {
    if (mount.Type === "volume" && !String(mount.Name).startsWith(`${project}_`)) {
      throw new Error(`Service ${service} uses a non-isolated volume`);
    }
  }
}
if (JSON.stringify([...byService.keys()].sort()) !== JSON.stringify(expectedServices)) {
  throw new Error("The isolated service set is incomplete or contains an unexpected service");
}

const networkIds = docker([
  "network",
  "ls",
  "-q",
  "--filter",
  `label=com.docker.compose.project=${project}`,
]);
if (networkIds === "") throw new Error("The isolated project has no networks");
const networks = JSON.parse(docker(["network", "inspect", ...networkIds.split("\n")])).sort(
  (left, right) => left.Name.localeCompare(right.Name),
);
const expectedNetworks = new Map([
  [`${project}_application`, true],
  [`${project}_database`, true],
  [`${project}_edge`, false],
  [`${project}_executor-egress`, false],
]);
if (networks.length !== expectedNetworks.size) {
  throw new Error("The isolated project network set is incomplete or unexpected");
}
for (const network of networks) {
  if (expectedNetworks.get(network.Name) !== network.Internal) {
    throw new Error(`Network isolation is invalid for ${network.Name}`);
  }
}
for (const [service, container] of byService) {
  for (const network of Object.keys(container.NetworkSettings?.Networks ?? {})) {
    if (!expectedNetworks.has(network)) {
      throw new Error(`Service ${service} is attached to a non-isolated project network`);
    }
  }
}

const published = [];
for (const [service, container] of byService) {
  for (const [containerPort, bindings] of Object.entries(
    container.HostConfig?.PortBindings ?? {},
  )) {
    for (const binding of bindings ?? []) {
      if (binding.HostIp !== "127.0.0.1") throw new Error("A host port is not loopback-bound");
      published.push({ service, container_port: containerPort, host_port: binding.HostPort });
    }
  }
}
published.sort((left, right) => left.service.localeCompare(right.service));
const expectedPublished = [
  { service: "caddy", container_port: "8080/tcp", host_port: ingressPort },
  { service: "litellm", container_port: "4000/tcp", host_port: liteLlmPort },
];
if (JSON.stringify(published) !== JSON.stringify(expectedPublished)) {
  throw new Error("The isolated project exposes an unexpected host port");
}

function environmentKeys(service) {
  return new Set(
    (byService.get(service).Config?.Env ?? []).map((entry) => entry.slice(0, entry.indexOf("="))),
  );
}
function environmentValues(service) {
  return new Map(
    (byService.get(service).Config?.Env ?? []).map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
}
const forbidden = {
  api: ["LITELLM_MASTER_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
  worker: [
    "ADMIN_INITIAL_PASSWORD",
    "INGEST_API_KEY",
    "POLICY_API_KEY",
    "ADMIN_API_KEY",
    "API_KEY_PEPPER",
    "CLICKHOUSE_BOOTSTRAP_PASSWORD",
    "CLICKHOUSE_MIGRATION_USERNAME",
    "CLICKHOUSE_MIGRATION_PASSWORD",
    "LITELLM_MASTER_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
  ],
};
const apiEnvironment = environmentValues("api");
for (const key of [
  "CLICKHOUSE_BOOTSTRAP_PASSWORD",
  "CLICKHOUSE_MIGRATION_USERNAME",
  "CLICKHOUSE_MIGRATION_PASSWORD",
]) {
  if (!apiEnvironment.has(key) || apiEnvironment.get(key) !== "") {
    throw new Error(`Service api did not explicitly empty privileged key ${key}`);
  }
}
for (const [service, keys] of Object.entries(forbidden)) {
  const actual = environmentKeys(service);
  for (const key of keys) {
    if (actual.has(key)) throw new Error(`Service ${service} received forbidden key ${key}`);
  }
}

const imageRows = [...byService]
  .map(([service, container]) => ({
    service,
    image_id: container.Image,
    image_ref: container.Config.Image,
  }))
  .sort((left, right) => left.service.localeCompare(right.service));
await writeFile(
  imageManifest,
  imageRows.map((row) => `${row.service}|${row.image_id}|${row.image_ref}`).join("\n") + "\n",
  { mode: 0o600 },
);
process.stdout.write(
  `${JSON.stringify(
    {
      status: "passed",
      project,
      services: expectedServices,
      published_ports: published,
      networks: Object.fromEntries(networks.map((network) => [network.Name, network.Internal])),
      image_ids: Object.fromEntries(imageRows.map((row) => [row.service, row.image_id])),
    },
    null,
    2,
  )}\n`,
);

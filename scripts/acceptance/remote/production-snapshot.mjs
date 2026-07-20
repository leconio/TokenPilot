#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import os from "node:os";

const protectedProject = process.env.ACCEPTANCE_PRODUCTION_PROJECT ?? "tokenpilot";
const designatedAddress = process.env.ACCEPTANCE_HOST_ADDRESS;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}

if (process.platform !== "linux" || process.env.REMOTE_DOCKER_ACCEPTANCE !== "1") {
  fail("Production snapshots are restricted to the authorized remote Linux acceptance host");
}
if (!designatedAddress) fail("ACCEPTANCE_HOST_ADDRESS is required");
if (!/^tokenpilot(?:-[a-z0-9]+)*$/u.test(protectedProject)) {
  fail("The protected production project name is invalid");
}
const addresses = Object.values(os.networkInterfaces())
  .flatMap((interfaces) => interfaces ?? [])
  .map((entry) => entry.address);
if (!addresses.includes(designatedAddress)) fail("The designated acceptance address is absent");

function docker(arguments_, options = {}) {
  return execFileSync("docker", arguments_, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  }).trim();
}

function labeledIds(kind) {
  const noun = kind === "container" ? ["ps", "-aq"] : [kind, "ls", "-q"];
  const output = docker([
    ...noun,
    "--filter",
    `label=com.docker.compose.project=${protectedProject}`,
  ]);
  return output === "" ? [] : output.split("\n").sort();
}

const containerIds = labeledIds("container");
if (containerIds.length === 0) fail("The protected production project has no containers");
const containers = JSON.parse(docker(["inspect", ...containerIds])).map((value) => ({
  id: value.Id,
  name: String(value.Name ?? "").replace(/^\//u, ""),
  service: value.Config?.Labels?.["com.docker.compose.service"] ?? null,
  image_ref: value.Config?.Image ?? null,
  image_id: value.Image,
  created_at: value.Created,
  state: value.State?.Status ?? null,
  health: value.State?.Health?.Status ?? null,
  exit_code: value.State?.ExitCode ?? null,
  started_at: value.State?.StartedAt ?? null,
  finished_at: value.State?.FinishedAt ?? null,
  restart_count: value.RestartCount,
  network_mode: value.HostConfig?.NetworkMode ?? null,
  port_bindings: value.HostConfig?.PortBindings ?? {},
  readonly_rootfs: value.HostConfig?.ReadonlyRootfs ?? false,
  user: value.Config?.User || "default",
  volumes: (value.Mounts ?? [])
    .filter((mount) => mount.Type === "volume")
    .map((mount) => ({ name: mount.Name, destination: mount.Destination }))
    .sort((left, right) => left.name.localeCompare(right.name)),
}));
containers.sort((left, right) => left.service.localeCompare(right.service));

const protectedImageReferences = [...new Set(containers.map((value) => value.image_ref))]
  .map((reference) => {
    if (typeof reference !== "string" || reference.length === 0) {
      fail("A protected production container has no configured image reference");
    }
    let value;
    try {
      [value] = JSON.parse(docker(["image", "inspect", reference]));
    } catch {
      fail(`Protected production image reference is not resolvable: ${reference}`);
    }
    return {
      reference,
      image_id: value.Id,
      repo_tags: [...(value.RepoTags ?? [])].sort(),
      repo_digests: [...(value.RepoDigests ?? [])].sort(),
    };
  })
  .sort((left, right) => left.reference.localeCompare(right.reference));

const networkIds = labeledIds("network");
const networks =
  networkIds.length === 0
    ? []
    : JSON.parse(docker(["network", "inspect", ...networkIds]))
        .map((value) => ({
          id: value.Id,
          name: value.Name,
          driver: value.Driver,
          scope: value.Scope,
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
const volumeNames = labeledIds("volume");
const volumes =
  volumeNames.length === 0
    ? []
    : JSON.parse(docker(["volume", "inspect", ...volumeNames]))
        .map((value) => ({ name: value.Name, driver: value.Driver, scope: value.Scope }))
        .sort((left, right) => left.name.localeCompare(right.name));

process.stdout.write(
  `${JSON.stringify(
    {
      schema_version: "current",
      captured_at: new Date().toISOString(),
      protected_project: protectedProject,
      host: os.hostname(),
      containers,
      protected_image_references: protectedImageReferences,
      networks,
      volumes,
    },
    null,
    2,
  )}\n`,
);

#!/usr/bin/env node

import { spawn } from "node:child_process";
import os from "node:os";

const required = [
  "ACCEPTANCE_HOST_ADDRESS",
  "RELEASE_API_URL",
  "RELEASE_INGEST_API_KEY",
  "RELEASE_ADMIN_API_KEY",
  "RELEASE_RUNTIME_API_KEY",
];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  process.stderr.write(
    `Remote release acceptance requires ${missing.join(", ")}. Run it against the isolated stack on the authorized deployment host.\n`,
  );
  process.exit(2);
}
if (process.argv.length > 2) {
  process.stderr.write("Remote release acceptance does not permit partial-test arguments.\n");
  process.exit(2);
}
if (
  process.platform !== "linux" ||
  process.env.REMOTE_DOCKER_ACCEPTANCE !== "1" ||
  process.env.RELEASE_ISOLATED_STACK !== "true"
) {
  process.stderr.write(
    "Remote release acceptance requires Linux, REMOTE_DOCKER_ACCEPTANCE=1, and RELEASE_ISOLATED_STACK=true.\n",
  );
  process.exit(2);
}
const addresses = Object.values(os.networkInterfaces())
  .flatMap((entries) => entries ?? [])
  .map((entry) => entry.address);
if (!addresses.includes(process.env.ACCEPTANCE_HOST_ADDRESS)) {
  process.stderr.write("Remote release acceptance is restricted to ACCEPTANCE_HOST_ADDRESS.\n");
  process.exit(2);
}
const releaseUrl = new URL(process.env.RELEASE_API_URL);
const releasePort = Number(releaseUrl.port);
if (
  !new Set(["127.0.0.1", "localhost", "::1"]).has(releaseUrl.hostname) ||
  releaseUrl.username !== "" ||
  releaseUrl.password !== "" ||
  !Number.isInteger(releasePort) ||
  releasePort < 20_000 ||
  releasePort > 60_999
) {
  process.stderr.write(
    "RELEASE_API_URL must use a loopback host and an isolated high port from 20000 through 60999.\n",
  );
  process.exit(2);
}

const child = spawn(
  "./node_modules/.bin/vitest",
  [
    "run",
    "--no-file-parallelism",
    "--testTimeout=420000",
    "tests/release/current-stack.remote.test.ts",
    "tests/release/current-domain.remote.test.ts",
  ],
  {
    env: { ...process.env, REMOTE_RELEASE_ACCEPTANCE: "true" },
    stdio: "inherit",
  },
);
child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const webDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const port = process.env.PLAYWRIGHT_PORT ?? "3100";
if (!/^[1-9][0-9]{0,4}$/u.test(port) || Number(port) > 65_535) {
  throw new TypeError("PLAYWRIGHT_PORT must be a valid TCP port");
}

const nextBinary = join(webDirectory, "node_modules", ".bin", "next");
const build = spawnSync(nextBinary, ["build"], {
  cwd: webDirectory,
  env: process.env,
  stdio: "inherit",
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const standaloneWeb = join(webDirectory, ".next", "standalone", "apps", "web");
const staticTarget = join(standaloneWeb, ".next", "static");
rmSync(staticTarget, { force: true, recursive: true });
mkdirSync(dirname(staticTarget), { recursive: true });
cpSync(join(webDirectory, ".next", "static"), staticTarget, { recursive: true });

const publicSource = join(webDirectory, "public");
const publicTarget = join(standaloneWeb, "public");
rmSync(publicTarget, { force: true, recursive: true });
if (existsSync(publicSource)) cpSync(publicSource, publicTarget, { recursive: true });

const server = spawn(process.execPath, [join(standaloneWeb, "server.js")], {
  cwd: standaloneWeb,
  env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: port },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.kill(signal));
}
server.once("error", (error) => {
  throw error;
});
server.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

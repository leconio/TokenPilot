import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { usageEventSchema } from "../../packages/contracts/src/index.js";

const root = new URL("../../", import.meta.url);
const children = new Set<ReturnType<typeof spawn>>();

afterEach(async () => {
  for (const child of children) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
  children.clear();
});

async function runNode(arguments_: readonly string[]): Promise<string> {
  const child = spawn(process.execPath, [...arguments_], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const [exitCode] = (await once(child, "exit")) as [number | null];
  if (exitCode !== 0) throw new Error(`Example exited ${exitCode}: ${stderr}`);
  return stdout;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not allocate a port");
  const { port } = address;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForHealthy(url: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // Startup races are expected; the child stderr is surfaced if it exits.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Fake Provider did not become healthy");
}

describe("key-free release examples", () => {
  it("generates deterministic Contract-valid peak and fallback attempt events", async () => {
    const first = JSON.parse(
      await runNode([
        "examples/usage-generator/generate.mjs",
        "--scenario",
        "fallback",
        "--count",
        "2",
        "--seed",
        "release-test",
      ]),
    ) as { events: unknown[] };
    const second = JSON.parse(
      await runNode([
        "examples/usage-generator/generate.mjs",
        "--scenario",
        "fallback",
        "--count",
        "2",
        "--seed",
        "release-test",
      ]),
    ) as { events: unknown[] };

    const events = first.events.map((event) => usageEventSchema.parse(event));
    expect(second).toEqual(first);
    expect(events).toHaveLength(2);
    expect(events[0]!.request.request_id).toBe(events[1]!.request.request_id);
    expect(events[0]!.result).toMatchObject({ status: "failure", http_status: 503 });
    expect(events[1]!.route?.fallback_from).toBe("fake/openai-fast");
    expect(events[1]!.usage).toMatchObject({
      uncached_input_tokens: "400",
      cache_read_input_tokens: "800",
    });
  });

  it("serves OpenAI-compatible synthetic usage and a deterministic fallback failure", async () => {
    const port = await availablePort();
    const child = spawn(process.execPath, ["examples/fake-provider/server.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        FAKE_PROVIDER_HOST: "127.0.0.1",
        FAKE_PROVIDER_PORT: String(port),
        FAKE_PROVIDER_FAIL_MODELS: "fake-openai-primary",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    const url = `http://127.0.0.1:${port}`;
    await waitForHealthy(url);

    const success = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "text.fast", messages: [] }),
    });
    expect(success.status).toBe(200);
    await expect(success.json()).resolves.toMatchObject({
      model: "text.fast",
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 300,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    });

    const selectedFailure = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/fake-openai-primary", messages: [] }),
    });
    expect(selectedFailure.status).toBe(503);
    await expect(selectedFailure.json()).resolves.toMatchObject({
      error: {
        code: "FAKE_PRIMARY_UNAVAILABLE",
        model: "openai/fake-openai-primary",
      },
    });

    const selectedFallback = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-gemini-fallback", messages: [] }),
    });
    expect(selectedFallback.status).toBe(200);

    const failure = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fake-fail": "true" },
      body: JSON.stringify({ model: "text.fast" }),
    });
    expect(failure.status).toBe(503);
    await expect(failure.json()).resolves.toMatchObject({
      error: { code: "FAKE_PRIMARY_UNAVAILABLE" },
    });

    const deploymentFailure = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fake-deployment-id": "primary-deployment",
      },
      body: JSON.stringify({
        model: "otherwise-healthy",
        metadata: { fake_failure_deployments: ["primary-deployment"] },
      }),
    });
    expect(deploymentFailure.status).toBe(503);
    await expect(deploymentFailure.json()).resolves.toMatchObject({
      error: {
        model: "otherwise-healthy",
        deployment_id: "primary-deployment",
      },
    });
  });
});

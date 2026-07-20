import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

interface ModelListEntry {
  readonly apiBase: string | undefined;
  readonly apiKey: string;
  readonly deploymentId: string;
  readonly model: string;
  readonly order: number;
  readonly tags: readonly string[];
  readonly weight: number;
}

function requiredMatch(block: string, pattern: RegExp, label: string): string {
  const value = block.match(pattern)?.[1];
  if (value === undefined) throw new Error(`Missing ${label} in LiteLLM model-list entry`);
  return value.trim();
}

function modelList(config: string): ModelListEntry[] {
  return config
    .split(/(?=^ {2}- model_name:)/mu)
    .slice(1)
    .map((block) => ({
      model: requiredMatch(block, /^\s+model: (.+)$/mu, "model"),
      apiKey: requiredMatch(block, /^\s+api_key: (.+)$/mu, "api_key"),
      apiBase: block.match(/^\s+api_base: (.+)$/mu)?.[1]?.trim(),
      tags: JSON.parse(requiredMatch(block, /^\s+tags: (\[.+\])$/mu, "tags")) as string[],
      order: Number(requiredMatch(block, /^\s+order: (\d+)$/mu, "order")),
      weight: Number(requiredMatch(block, /^\s+weight: (\d+)$/mu, "weight")),
      deploymentId: requiredMatch(block, /^\s+id: (.+)$/mu, "model_info.id"),
    }));
}

const exactRoutingMatrix = [
  {
    deploymentId: "openai-fast-prod",
    tags: ["cp:text.fast:peak", "cp:text.fast:default"],
    order: 1,
    weight: 80,
  },
  {
    deploymentId: "azure-fast-fallback",
    tags: ["cp:text.fast:peak", "cp:text.fast:default"],
    order: 1,
    weight: 20,
  },
  {
    deploymentId: "gemini-fast-prod",
    tags: ["cp:text.fast:peak", "cp:text.fast:default"],
    order: 2,
    weight: 100,
  },
  {
    deploymentId: "gemini-fast-prod",
    tags: ["cp:text.fast:offpeak"],
    order: 1,
    weight: 100,
  },
  {
    deploymentId: "openai-fast-prod",
    tags: ["cp:text.fast:offpeak"],
    order: 2,
    weight: 100,
  },
  {
    deploymentId: "azure-fast-fallback",
    tags: ["cp:text.fast:emergency"],
    order: 1,
    weight: 100,
  },
] as const;

function routingFields(entries: readonly ModelListEntry[]) {
  return entries.map(({ deploymentId, tags, order, weight }) => ({
    deploymentId,
    tags,
    order,
    weight,
  }));
}

function composeService(compose: string, service: string): string {
  const match = compose.match(
    new RegExp(`^  ${service}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|$(?![\\s\\S]))`, "m"),
  );
  if (match?.[0] === undefined) throw new Error(`Compose service is missing: ${service}`);
  return match[0];
}

describe("LiteLLM production and key-free demo configuration", () => {
  it("expresses the exact Peak, Offpeak, and Emergency matrix with three identities", async () => {
    const production = await readFile(new URL("deploy/litellm/config.example.yaml", root), "utf8");
    const entries = modelList(production);

    expect(routingFields(entries)).toEqual(exactRoutingMatrix);
    expect([...new Set(entries.map(({ deploymentId }) => deploymentId))].sort()).toEqual([
      "azure-fast-fallback",
      "gemini-fast-prod",
      "openai-fast-prod",
    ]);
    expect(new Set(entries.map(({ apiKey }) => apiKey))).toEqual(
      new Set([
        "os.environ/OPENAI_API_KEY",
        "os.environ/AZURE_OPENAI_API_KEY",
        "os.environ/GEMINI_API_KEY",
      ]),
    );
    expect(production).toContain("api_base: os.environ/AZURE_OPENAI_ENDPOINT");
    expect(production).toContain("api_version: os.environ/AZURE_OPENAI_API_VERSION");
    expect(production).toContain("turn_off_message_logging: true");
    expect(production).toContain("callbacks:");
    expect(production).toContain("success_callback:");
    expect(production).toContain("failure_callback:");
    expect(production).toContain("- ai_control_callback.proxy_handler_instance");
    expect(production).not.toContain("demo-not-a-provider-credential");
  });

  it("keeps the fake Provider key-free while preserving the production routing matrix", async () => {
    const demo = await readFile(new URL("deploy/litellm/config.demo.yaml", root), "utf8");
    const entries = modelList(demo);
    const productionRouteEntries = entries.filter(
      ({ tags }) => !tags.includes("cp:text.fast:fallback-demo"),
    );
    const fallbackDemoEntries = entries.filter(({ tags }) =>
      tags.includes("cp:text.fast:fallback-demo"),
    );

    expect(routingFields(productionRouteEntries)).toEqual(exactRoutingMatrix);
    expect(routingFields(fallbackDemoEntries)).toEqual([
      {
        deploymentId: "openai-fast-prod",
        tags: ["cp:text.fast:fallback-demo"],
        order: 1,
        weight: 100,
      },
      {
        deploymentId: "gemini-fast-prod",
        tags: ["cp:text.fast:fallback-demo"],
        order: 1,
        weight: 100,
      },
    ]);
    expect(entries.every(({ model }) => model.startsWith("openai/fake-"))).toBe(true);
    expect(entries.every(({ apiBase }) => apiBase === "http://fake-provider:4100/v1")).toBe(true);
    expect(entries.every(({ apiKey }) => apiKey === "demo-not-a-provider-credential")).toBe(true);
    expect(demo).not.toMatch(/os\.environ\/(?:OPENAI|AZURE|GEMINI)/u);
    expect(demo).toContain("turn_off_message_logging: true");
    expect(demo).toContain("callbacks:");
    expect(demo).toContain("success_callback:");
    expect(demo).toContain("failure_callback:");
    expect(demo).toContain("- ai_control_callback.proxy_handler_instance");
    expect(demo).toContain("num_retries: 0");
    expect(demo).toContain("text.fast.demo-primary: [text.fast.demo-fallback]");
  });

  it("wires the optional demo without changing the production Compose defaults", async () => {
    const [
      base,
      override,
      demoEnvironment,
      callbackShim,
      setupPage,
      realStackFixtures,
      realStackVerification,
      runtimeDockerfile,
      fakeProviderDockerfile,
    ] = await Promise.all([
      readFile(new URL("deploy/docker-compose.yml", root), "utf8"),
      readFile(new URL("deploy/docker-compose.litellm-demo.yml", root), "utf8"),
      readFile(new URL("deploy/litellm/demo.env", root), "utf8"),
      readFile(new URL("deploy/litellm/ai_control_callback.py", root), "utf8"),
      readFile(new URL("apps/web/app/setup/page.tsx", root), "utf8"),
      readFile(new URL("apps/web/e2e/real-stack-fixtures.ts", root), "utf8"),
      readFile(new URL("apps/web/e2e/real-stack-verification.ts", root), "utf8"),
      readFile(new URL("deploy/docker/LiteLLM.Dockerfile", root), "utf8"),
      readFile(new URL("deploy/docker/FakeProvider.Dockerfile", root), "utf8"),
    ]);
    const fakeProvider = composeService(override, "fake-provider");
    const demoLiteLLM = composeService(override, "litellm");

    expect(composeService(base, "litellm")).toContain(
      "./litellm/config.example.yaml:/etc/litellm/config.yaml:ro",
    );
    expect(runtimeDockerfile).toContain(
      "deploy/litellm/ai_control_callback.py /etc/litellm/ai_control_callback.py",
    );
    expect(runtimeDockerfile).toContain("connectors/litellm/src/ /opt/tokenpilot-connector/");
    expect(composeService(base, "litellm")).toContain('user: "65532:65532"');
    expect(base).toContain(
      'NO_PROXY: "${NO_PROXY:-127.0.0.1,localhost},api,postgres,redis,clickhouse,fake-provider,litellm,caddy,web,worker,scheduler"',
    );
    expect(base).toContain(
      'no_proxy: "${no_proxy:-127.0.0.1,localhost},api,postgres,redis,clickhouse,fake-provider,litellm,caddy,web,worker,scheduler"',
    );
    expect(base).not.toMatch(/192\.168\./u);
    expect(override).not.toMatch(/192\.168\./u);
    expect(base).not.toContain("release-tooling");
    const baseLiteLLM = composeService(base, "litellm");
    expect(baseLiteLLM).toContain("<<: *internal-no-proxy");
    expect(baseLiteLLM).toContain("LITELLM_LOG: ERROR");
    expect(baseLiteLLM).not.toContain("INGEST_API_KEY");
    expect(baseLiteLLM).not.toContain("POLICY_API_KEY");
    expect(callbackShim).toContain(
      "from ai_control_litellm.callback import proxy_handler_instance",
    );
    expect(base).not.toContain("config.demo.yaml");
    expect(base).not.toContain("fake-provider:");
    expect(override).not.toContain("release-tooling");
    expect(fakeProvider).toContain("${FAKE_PROVIDER_IMAGE:-tokenpilot-fake-provider:0.2.0}");
    expect(fakeProvider).toContain("dockerfile: deploy/docker/FakeProvider.Dockerfile");
    expect(fakeProvider).not.toContain("../examples/fake-provider/server.mjs:/app/server.mjs");
    expect(fakeProviderDockerfile).toContain("rm -rf /usr/local/lib/node_modules/npm");
    expect(fakeProviderDockerfile).toContain("USER 1000:1000");
    expect(fakeProvider).toContain("FAKE_PROVIDER_FAIL_MODELS: fake-openai-primary");
    expect(fakeProvider).not.toMatch(/^\s+ports:/mu);
    expect(fakeProvider).toContain("networks: [application]");
    expect(demoLiteLLM).toContain("env_file: !override");
    expect(demoLiteLLM).toContain("./litellm/demo.env");
    expect(demoLiteLLM).toContain("${LITELLM_ENV_FILE:-./litellm/.env}");
    expect(demoLiteLLM).not.toContain("INGEST_API_KEY");
    expect(demoLiteLLM).not.toContain("POLICY_API_KEY");
    expect(demoLiteLLM).toContain("127.0.0.1");
    expect(demoLiteLLM).toContain("./litellm/config.demo.yaml:/etc/litellm/config.yaml:ro");
    expect(demoEnvironment).not.toMatch(/^AI_CONTROL_API_KEY=/mu);
    expect(demoEnvironment).not.toMatch(/^AI_CONTROL_POLICY_API_KEY=/mu);
    expect(demoEnvironment).toContain(
      "AI_CONTROL_POLICY_LKG_PATH=/var/lib/tokenpilot/runtime-snapshot.json",
    );
    expect(demoEnvironment).not.toMatch(/^(?:OPENAI|AZURE_OPENAI|GEMINI)_/mu);
    expect(realStackFixtures).toContain("REAL_STACK_APPLICATION_SLUG");
    expect(realStackVerification).toContain("applicationSlug");
    expect(realStackVerification).toContain("request_id: requestId");
    expect(realStackVerification).toContain("trace_id: traceId");
    expect(realStackVerification).not.toContain("business_request_id");
    expect(setupPage).toContain("AI_CONTROL_API_KEY=${issued.ingest.api_key}");
    expect(setupPage).toContain("AI_CONTROL_POLICY_API_KEY=${issued.policy.api_key}");
    expect(setupPage).toContain('scopes: ["usage:write", "connector:heartbeat"]');
    expect(setupPage).toContain('scopes: ["runtime:read", "runtime:write", "runtime:ack"]');
  });
});

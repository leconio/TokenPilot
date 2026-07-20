import { access, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

function composeService(compose: string, service: string): string {
  const match = compose.match(
    new RegExp(
      `^  ${service}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|^networks:|(?![\\s\\S]))`,
      "m",
    ),
  );
  if (match?.[0] === undefined) throw new Error(`Compose service is missing: ${service}`);
  return match[0];
}

describe("foundation acceptance", () => {
  it.each([
    "apps/web",
    "apps/api",
    "apps/migrate",
    "apps/worker",
    "apps/scheduler",
    "packages/contracts",
    "connectors/litellm",
    "sdks/node",
    "sdks/python",
  ])("contains %s", async (relativePath) => {
    await expect(access(new URL(relativePath, root))).resolves.toBeUndefined();
  });

  it("keeps local dependency and build caches out of the Docker context", async () => {
    const dockerignore = await readFile(new URL(".dockerignore", root), "utf8");

    for (const path of [".pnpm-store", ".turbo", "**/node_modules", "**/.venv", "**/.next"]) {
      expect(dockerignore.split("\n"), path).toContain(path);
    }
  });

  it("keeps database services private in the base Compose file", async () => {
    const compose = await readFile(new URL("deploy/docker-compose.yml", root), "utf8");
    const postgres = composeService(compose, "postgres");
    const redis = composeService(compose, "redis");
    const caddy = composeService(compose, "caddy");
    const api = composeService(compose, "api");

    expect(postgres).not.toMatch(/^\s+ports:/m);
    expect(redis).not.toMatch(/^\s+ports:/m);
    expect(compose.match(/^\s+ports:/gm)).toHaveLength(1);
    expect(caddy).toMatch(/^\s+ports:/m);
    expect(compose).toMatch(/database:\n\s+internal: true/);
    expect(api).toContain("executor-egress");
  });

  it("keeps operational metrics off the public Caddy listener", async () => {
    const caddy = await readFile(new URL("deploy/caddy/Caddyfile", root), "utf8");
    const publicMatcher = caddy.match(/@control_plane_public path (?<paths>[^\n]+)/u)?.groups
      ?.paths;
    const webMatcher = caddy.match(/@control_plane_web path (?<paths>[^\n]+)/u)?.groups?.paths;
    const webHandler = caddy.match(/handle @control_plane_web \{(?<body>[\s\S]*?)^\s+\}/mu)?.groups
      ?.body;
    expect(publicMatcher).toBeDefined();
    expect(publicMatcher).not.toMatch(/(?:^|\s)\/metrics(?:\s|$)/u);
    expect(publicMatcher).toMatch(/(?:^|\s)\/openapi-json(?:\s|$)/u);
    expect(webMatcher?.trim()).toBe("/web /web/*");
    expect(webHandler).toContain("reverse_proxy api:4000");
    expect(webHandler).not.toContain("header Authorization");
    expect(caddy.indexOf("handle @control_plane_web")).toBeLessThan(
      caddy.indexOf("handle @control_plane_api"),
    );
    expect(caddy).toMatch(/@control_plane_api \{\s+header Authorization \*/u);
    expect(caddy).not.toMatch(/handle \/metrics/u);
    expect(caddy).not.toContain("Strict-Transport-Security");
    expect(caddy).not.toContain("upgrade-insecure-requests");
  });

  it("runs every first-party container as a locked-down non-root user", async () => {
    const compose = await readFile(new URL("deploy/docker-compose.yml", root), "utf8");
    const nodeDockerfile = await readFile(new URL("deploy/docker/Dockerfile", root), "utf8");
    const liteLLMDockerfile = await readFile(
      new URL("deploy/docker/LiteLLM.Dockerfile", root),
      "utf8",
    );
    const datastoreDockerfile = await readFile(
      new URL("deploy/docker/Datastore.Dockerfile", root),
      "utf8",
    );
    const normalizedNodeDockerfile = nodeDockerfile
      .replace(/\\\s*\n\s*/gu, " ")
      .replace(/\s+/gu, " ");
    const caddyDockerfile = await readFile(new URL("deploy/docker/Caddy.Dockerfile", root), "utf8");

    expect(compose).toMatch(/x-node-service:[\s\S]*?read_only: true/);
    expect(compose).toMatch(/x-node-service:[\s\S]*?user: "1000:1000"/);
    expect(compose).toMatch(/x-node-service:[\s\S]*?cap_drop:\n\s+- ALL/);
    for (const service of ["migrate", "api", "worker", "scheduler", "web"]) {
      expect(composeService(compose, service)).toContain("<<: *node-service");
    }
    expect(composeService(compose, "caddy")).toContain("read_only: true");
    expect(nodeDockerfile).toContain("USER 1000:1000");
    expect(nodeDockerfile).toContain("chown -R node:node /var/lib/tokenpilot");
    expect(nodeDockerfile).toContain("pnpm install --prod --no-optional --frozen-lockfile");
    expect(nodeDockerfile).not.toContain(
      "COPY --from=build --chown=node:node /workspace /workspace",
    );
    expect(nodeDockerfile).toContain("ghcr.io/astral-sh/uv:0.11.28");
    expect(nodeDockerfile).toContain("apk add --no-cache bash postgresql16-client");
    expect(normalizedNodeDockerfile).toContain(
      "uv sync --project connectors/litellm --locked --no-dev --python 3.12",
    );
    expect(normalizedNodeDockerfile).toContain(
      "uv run --project connectors/litellm --offline --no-sync python",
    );
    for (const runtimeApp of ["api", "worker", "scheduler"]) {
      expect(normalizedNodeDockerfile).toContain(`--filter="@tokenpilot/${runtimeApp}..."`);
    }
    const productionRuntime = nodeDockerfile.split("FROM ${NODE_IMAGE} AS runtime")[1];
    expect(productionRuntime).toBeDefined();
    expect(productionRuntime).not.toContain("postgresql16-client");
    expect(productionRuntime).not.toContain("uv sync");
    expect(caddyDockerfile).toContain("chown -R 1000:1000 /data /config");
    expect(caddyDockerfile).toContain("USER 1000:1000");
    expect(liteLLMDockerfile).toContain("ARG LITELLM_BASE_IMAGE=ghcr.io/berriai/litellm:v1.92.0");
    expect(liteLLMDockerfile).toContain("'mcp==1.28.1'");
    expect(liteLLMDockerfile).toContain('assert version("mcp") == "1.28.1"');
    expect(liteLLMDockerfile).toContain("RUN apk upgrade --no-cache");
    expect(liteLLMDockerfile).toContain("for delay in 2 5 10");
    expect(liteLLMDockerfile).toContain('rm -rf "${site_packages}/ddtrace"');
    expect(liteLLMDockerfile).toContain('importlib.util.find_spec("ddtrace") is None');
    expect(liteLLMDockerfile).toContain("python -c 'import litellm'");
    expect(liteLLMDockerfile).toContain("chown -R 65532:65532 /var/lib/tokenpilot");
    expect(liteLLMDockerfile).toContain(
      "COPY --chown=0:0 connectors/litellm/src/ /opt/tokenpilot-connector/",
    );
    expect(liteLLMDockerfile).toContain("chmod 0700 /var/lib/tokenpilot");
    expect(liteLLMDockerfile).toContain("USER 65532:65532");
    expect(datastoreDockerfile).toContain("rm -f /usr/local/bin/gosu");
    expect(datastoreDockerfile).toContain("USER 70:70");
    expect(datastoreDockerfile).toContain("USER 999:1000");
  });

  it("caches connector dependencies independently from the full source tree", async () => {
    const dockerfile = await readFile(new URL("deploy/docker/Dockerfile", root), "utf8");
    const toolingStage = dockerfile
      .split("FROM toolchain AS tooling")[1]
      ?.split("FROM ${NODE_IMAGE} AS runtime")[0];
    expect(toolingStage).toBeDefined();

    const normalized = toolingStage?.replace(/\\\s*\n\s*/gu, " ").replace(/\s+/gu, " ") ?? "";
    const metadataCopy =
      "COPY connectors/litellm/pyproject.toml connectors/litellm/uv.lock connectors/litellm/README.md ./connectors/litellm/";
    const sourceCopy = "COPY connectors/litellm/src/ ./connectors/litellm/src/";
    const connectorInstall = "apk add --no-cache --virtual .connector-build-deps build-base cargo";
    const offlineImport = "uv run --project connectors/litellm --offline --no-sync python";
    const fullSourceCopy = "COPY . .";

    expect(normalized).toContain(metadataCopy);
    expect(normalized).toContain(sourceCopy);
    expect(normalized.indexOf(metadataCopy)).toBeLessThan(normalized.indexOf(connectorInstall));
    expect(normalized.indexOf(sourceCopy)).toBeLessThan(normalized.indexOf(connectorInstall));
    expect(normalized.indexOf(connectorInstall)).toBeLessThan(normalized.indexOf(offlineImport));
    expect(normalized.indexOf(offlineImport)).toBeLessThan(normalized.indexOf(fullSourceCopy));
    expect(toolingStage?.match(/^COPY \. \.$/gmu)).toHaveLength(1);
  });

  it("keeps Worker runtime imports in production dependencies", async () => {
    const workerPackage = JSON.parse(
      await readFile(new URL("apps/worker/package.json", root), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(workerPackage.dependencies?.["@tokenpilot/contracts"]).toBe("workspace:*");
    expect(workerPackage.devDependencies).not.toHaveProperty("@tokenpilot/contracts");
  });

  it("passes the required non-secret instance identity to Worker", async () => {
    const compose = await readFile(new URL("deploy/docker-compose.yml", root), "utf8");
    const worker = composeService(compose, "worker");

    expect(worker).toContain('INSTANCE_ID: "${INSTANCE_ID:?INSTANCE_ID is required}"');
    expect(worker).toContain('ENVIRONMENT: "${ENVIRONMENT:?ENVIRONMENT is required}"');
    expect(worker).not.toContain("env_file:");
  });

  it("captures the administrator from the current Web session identity", async () => {
    const preparation = await readFile(
      new URL("scripts/acceptance/remote/prepare-web-acceptance.mjs", root),
      "utf8",
    );

    expect(preparation).toContain("identified.body?.user?.userId");
    expect(preparation).toContain("adminUserId = identified.body?.user?.userId");
    expect(preparation).not.toContain("identified.body?.user?.id");
  });

  it("loads integration-test configuration without writing into production dependencies", async () => {
    for (const packagePath of [
      "packages/db/package.json",
      "apps/api/package.json",
      "apps/worker/package.json",
    ]) {
      const packageManifest = JSON.parse(await readFile(new URL(packagePath, root), "utf8")) as {
        scripts?: Record<string, string>;
      };

      expect(packageManifest.scripts?.["test:integration"], packagePath).toContain(
        "--configLoader runner",
      );
    }
  });

  it("locks down datastore, executor, and observability runtime identities", async () => {
    const compose = await readFile(new URL("deploy/docker-compose.yml", root), "utf8");
    const expectations = new Map([
      ["postgres", "70:70"],
      ["redis", "999:1000"],
      ["litellm", "65532:65532"],
      ["prometheus", "65534:65534"],
      ["node-exporter", "65534:65534"],
    ]);

    for (const [service, user] of expectations) {
      const definition = composeService(compose, service);
      expect(definition).toContain(`user: "${user}"`);
      expect(definition).toContain("read_only: true");
      expect(definition).toContain("no-new-privileges:true");
      expect(definition).toMatch(/cap_drop:\s*\[ALL\]|cap_drop:\n\s+- ALL/u);
    }
    expect(composeService(compose, "postgres")).toContain(
      "/var/run/postgresql:rw,nosuid,nodev,mode=3775,uid=70,gid=70",
    );
    expect(composeService(compose, "postgres")).toContain(
      "dockerfile: deploy/docker/Datastore.Dockerfile",
    );
    expect(composeService(compose, "postgres")).toContain("target: postgres");
    expect(composeService(compose, "redis")).toContain("target: redis");
    expect(composeService(compose, "litellm")).toContain(
      "dockerfile: deploy/docker/LiteLLM.Dockerfile",
    );
    expect(composeService(compose, "litellm")).not.toContain(
      "../connectors/litellm/src:/opt/tokenpilot-connector",
    );
  });

  it("binds the public edge to loopback unless an operator explicitly opts in", async () => {
    const compose = await readFile(new URL("deploy/docker-compose.yml", root), "utf8");
    const caddy = composeService(compose, "caddy");

    expect(caddy).toContain('"${CADDY_BIND_ADDRESS:-127.0.0.1}:${HTTP_PORT:-8080}:8080"');
    expect(caddy).not.toContain("CADDY_BIND_ADDRESS:-0.0.0.0");
  });

  it("lets an existing gateway replace the bundled Caddy listener", async () => {
    const compose = await readFile(
      new URL("deploy/docker-compose.external-gateway.yml", root),
      "utf8",
    );

    expect(composeService(compose, "api")).toContain(
      "${EXTERNAL_GATEWAY_API_BIND_ADDRESS:-127.0.0.1}:${EXTERNAL_GATEWAY_API_PORT:-15001}:4000",
    );
    expect(composeService(compose, "web")).toContain(
      "${EXTERNAL_GATEWAY_WEB_BIND_ADDRESS:-127.0.0.1}:${EXTERNAL_GATEWAY_WEB_PORT:-15002}:3000",
    );
    expect(composeService(compose, "caddy")).toContain("profiles: [bundled-ingress]");
  });

  it("defines an in-container health check for every long-lived Compose service", async () => {
    const compose = await readFile(new URL("deploy/docker-compose.yml", root), "utf8");
    for (const service of [
      "postgres",
      "redis",
      "api",
      "worker",
      "scheduler",
      "web",
      "caddy",
      "litellm",
      "prometheus",
      "node-exporter",
    ]) {
      expect(composeService(compose, service), service).toContain("healthcheck:");
    }
    expect(composeService(compose, "migrate")).not.toContain("healthcheck:");
    for (const service of ["caddy", "prometheus", "node-exporter"]) {
      expect(composeService(compose, service), service).toContain('"-Y"');
      expect(composeService(compose, service), service).toContain('"off"');
    }
  });

  it("SBOMs and blocks High/Critical vulnerabilities across the complete runtime matrix", async () => {
    const workflow = await readFile(new URL(".github/workflows/supply-chain.yml", root), "utf8");
    for (const imageOrTarget of [
      "matrix.app",
      "tokenpilot-caddy",
      "tokenpilot-litellm",
      "tokenpilot-release-tooling",
      "postgres:16.14-alpine3.24",
      "redis:7.4.9-alpine3.21",
      "deploy/docker/Observability.Dockerfile",
      "node:24.18.0-alpine3.24",
    ]) {
      expect(workflow, imageOrTarget).toContain(imageOrTarget);
    }
    expect(workflow.match(/severity: HIGH,CRITICAL/gu)?.length).toBeGreaterThanOrEqual(7);
    expect(workflow.match(/format: cyclonedx-json/gu)?.length).toBeGreaterThanOrEqual(6);
    expect(workflow).toContain("ignore-unfixed: false");
    expect(workflow).toContain('exit-code: "1"');
    expect(workflow).toContain("image_id={{.Id}}");
  });

  it("builds observability images from one immutable multi-architecture lock source", async () => {
    const [compose, dockerfile, runner] = await Promise.all([
      readFile(new URL("deploy/docker-compose.yml", root), "utf8"),
      readFile(new URL("deploy/docker/Observability.Dockerfile", root), "utf8"),
      readFile(new URL("scripts/acceptance/remote/run.sh", root), "utf8"),
    ]);
    expect(dockerfile).toContain(
      "prom/prometheus:v3.13.1@sha256:3c42b892cf723fa54d2f262c37a0e1f80aa8c8ddb1da7b9b0df9455a35a7f893",
    );
    expect(dockerfile).toContain(
      "prom/node-exporter:v1.12.1@sha256:1b4e4438faca4dd7e001dd445d161a4a2091b0fededa84093b3a8dfeae1f1be0",
    );
    expect(dockerfile.match(/^USER 65534:65534$/gmu)).toHaveLength(2);
    for (const service of ["prometheus", "node-exporter"]) {
      expect(composeService(compose, service)).toContain(
        "dockerfile: deploy/docker/Observability.Dockerfile",
      );
      expect(composeService(compose, service)).toContain(`target: ${service}`);
    }
    expect(runner).not.toContain("seed_image 'prom/");
  });

  it("documents the gateway boundary in the consolidated concepts guide", async () => {
    const concepts = await readFile(new URL("docs/concepts.md", root), "utf8");
    expect(concepts).toContain("LiteLLM");
    expect(concepts).toContain("does not proxy model traffic");
  });

  it("does not rediscover generated deployment-test workspaces", async () => {
    const vitest = await readFile(new URL("vitest.config.ts", root), "utf8");
    expect(vitest).toContain('"**/.tokenpilot/**"');
  });
});

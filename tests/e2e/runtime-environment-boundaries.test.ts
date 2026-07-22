import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

function composeService(compose: string, service: string): string {
  const match = compose.match(
    new RegExp(`^  ${service}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|^networks:)`, "m"),
  );
  if (match?.[0] === undefined) throw new Error(`Compose service is missing: ${service}`);
  return match[0];
}

function directEnvironmentKeys(service: string): string[] {
  const block = service.match(/^ {4}environment:\n((?:^ {6}.*\n?)*)/mu)?.[1];
  if (block === undefined) throw new Error("Compose service has no direct environment mapping");
  return [...block.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gmu)]
    .map((match) => match[1])
    .filter((key): key is string => key !== undefined)
    .sort();
}

describe("Compose runtime environment boundaries", () => {
  it("injects only purpose-specific settings into non-API first-party services", async () => {
    const compose = await readFile(new URL("deploy/docker-compose.yml", root), "utf8");
    const expectedKeys = new Map<string, string[]>([
      ["migrate", ["DATABASE_URL", "SHADOW_DATABASE_URL"]],
      [
        "worker",
        [
          "BASE_CURRENCY",
          "CONNECTOR_STALE_AFTER_SECONDS",
          "DATABASE_URL",
          "ENVIRONMENT",
          "EXPORT_DIRECTORY",
          "INSTANCE_ID",
          "REDIS_URL",
          "WORKER_METRICS_HOST",
          "WORKER_METRICS_PORT",
        ],
      ],
      ["scheduler", ["REDIS_URL"]],
      ["web", ["API_INTERNAL_URL"]],
    ]);

    for (const [serviceName, keys] of expectedKeys) {
      const service = composeService(compose, serviceName);
      expect(service, serviceName).not.toContain("env_file:");
      expect(directEnvironmentKeys(service), serviceName).toEqual(keys);
      for (const forbidden of [
        "ADMIN_INITIAL_PASSWORD",
        "INGEST_API_KEY",
        "POLICY_API_KEY",
        "ADMIN_API_KEY",
        "API_KEY_PEPPER",
        "LITELLM_MASTER_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
      ]) {
        expect(service, `${serviceName} received ${forbidden}`).not.toContain(forbidden);
      }
    }

    const api = composeService(compose, "api");
    expect(api).toContain("env_file:");
    expect(api).toContain('CLICKHOUSE_BOOTSTRAP_PASSWORD: ""');
    expect(api).toContain('CLICKHOUSE_MIGRATION_USERNAME: ""');
    expect(api).toContain('CLICKHOUSE_MIGRATION_PASSWORD: ""');
    expect(composeService(compose, "caddy")).not.toContain("CADDY_ADDRESS");
  });

  it("routes Web control requests through the runtime-only internal API address", async () => {
    const [nextConfig, controlRoute] = await Promise.all([
      readFile(new URL("apps/web/next.config.ts", root), "utf8"),
      readFile(new URL("apps/web/app/api/control/[...path]/route.ts", root), "utf8"),
    ]);

    expect(nextConfig).not.toContain("rewrites()");
    expect(nextConfig).not.toContain("CONTROL_PLANE_API_URL");
    expect(nextConfig).not.toContain("Strict-Transport-Security");
    expect(controlRoute).toContain(
      'process.env.API_INTERNAL_URL ?? process.env.API_BASE_URL ?? "http://127.0.0.1:4000"',
    );
    expect(controlRoute).toContain("controlProxyRequestHeaders(request.url, request.headers)");
  });

  it("does not send trust-required browser headers from the plain HTTP ingress", async () => {
    const caddy = await readFile(new URL("deploy/caddy/Caddyfile", root), "utf8");
    expect(caddy).not.toContain("Cross-Origin-Opener-Policy");
    expect(caddy).not.toContain("Strict-Transport-Security");
  });
});

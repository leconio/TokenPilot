import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const composePath = fileURLToPath(
  new URL("../../../deploy/docker-compose.clickhouse.yml", import.meta.url),
);
const mainComposePath = fileURLToPath(
  new URL("../../../deploy/docker-compose.yml", import.meta.url),
);
const nodeDockerfilePath = fileURLToPath(
  new URL("../../../deploy/docker/Dockerfile", import.meta.url),
);
const testComposePath = fileURLToPath(
  new URL("../../../deploy/docker-compose.clickhouse.test.yml", import.meta.url),
);
const bootstrapPath = fileURLToPath(
  new URL("../../../deploy/clickhouse/init/001-create-least-privilege-users.sh", import.meta.url),
);
const entrypointPath = fileURLToPath(
  new URL(
    "../../../deploy/clickhouse/entrypoint/tokenpilot-clickhouse-entrypoint.sh",
    import.meta.url,
  ),
);
const defaultUserConfigPath = fileURLToPath(
  new URL("../../../deploy/clickhouse/config/users.d/zz-default-local-only.xml", import.meta.url),
);
const healthcheckPath = fileURLToPath(
  new URL("../../../deploy/clickhouse/healthcheck.sh", import.meta.url),
);

describe("ClickHouse Compose contract", () => {
  it("pins the full LTS image and keeps the standalone service mandatory", async () => {
    const compose = await readFile(composePath, "utf8");

    expect(compose).toContain(
      "clickhouse:26.3.17.4@sha256:158dcce6f6fdc59309650aad6b79484abf4eed07d4e0bdba31d732e64b5a25fb",
    );
    expect(compose).toContain(
      "CLICKHOUSE_IMAGE:-clickhouse:26.3.17.4@sha256:158dcce6f6fdc59309650aad6b79484abf4eed07d4e0bdba31d732e64b5a25fb",
    );
    expect(compose).toContain("CLICKHOUSE_PULL_POLICY:-if_not_present");
    expect(compose).not.toMatch(/clickhouse:(?:latest|lts)(?:\s|@|\})/u);
    expect(compose).not.toContain("profiles: [clickhouse]");
    expect(compose).toContain("clickhouse-data:/var/lib/clickhouse");
    expect(compose).toContain('user: "101:101"');
    expect(compose).toContain("cap_drop: [ALL]");
    expect(compose).not.toContain("cap_add:");
    expect(compose).toContain(
      "/etc/clickhouse-server/users.d:rw,noexec,nosuid,nodev,mode=0755,uid=101,gid=101",
    );
    expect(compose).toContain("read_only: true");
    expect(compose).not.toContain("ports:");
    expect(compose).toContain("CLICKHOUSE_PASSWORD is required");
  });

  it("includes ClickHouse and its migration in the default application stack", async () => {
    const compose = await readFile(mainComposePath, "utf8");

    expect(compose).toMatch(/^ {2}clickhouse:\s*$/mu);
    expect(compose).toMatch(/^ {2}clickhouse-migrate:\s*$/mu);
    expect(compose).not.toContain("profiles: [clickhouse]");
    expect(compose).toContain("clickhouse-migrate: { condition: service_completed_successfully }");
    expect(compose).not.toContain("CLICKHOUSE_ENABLED");
  });

  it("packages migration SQL in the worker image used by clickhouse-migrate", async () => {
    const [compose, dockerfile] = await Promise.all([
      readFile(mainComposePath, "utf8"),
      readFile(nodeDockerfilePath, "utf8"),
    ]);

    expect(compose).toContain("image: ${WORKER_IMAGE:-tokenpilot-worker:0.2.0}");
    expect(compose).toContain(
      "CLICKHOUSE_MIGRATIONS_DIR: /workspace/packages/clickhouse/migrations",
    );
    expect(dockerfile).toContain(
      "cp -R packages/clickhouse/migrations /compiled/packages/clickhouse/migrations",
    );
  });

  it("publishes a loopback port only in the explicit test override", async () => {
    const testCompose = await readFile(testComposePath, "utf8");

    expect(testCompose).toContain("127.0.0.1");
    expect(testCompose).toContain("CLICKHOUSE_TEST_PORT");
    expect(testCompose).not.toContain("CLICKHOUSE_TEST_BIND_ADDRESS");
    expect(testCompose).toContain("internal: false");
  });

  it("creates separate runtime and migration grants", async () => {
    const bootstrap = await readFile(bootstrapPath, "utf8");

    expect(bootstrap).toContain("GRANT SELECT, INSERT ON ${database}.* TO ai_control_runtime_role");
    expect(bootstrap).toContain("GRANT SELECT ON system.disks TO ai_control_runtime_role");
    expect(
      [...bootstrap.matchAll(/GRANT SELECT ON system\.([A-Za-z_*]+) TO ai_control_runtime_role;/gu)]
        .map((match) => match[1])
        .sort(),
    ).toEqual(["disks"]);
    expect(bootstrap).not.toMatch(/GRANT\s+SELECT\s+ON\s+system\.\*/iu);
    expect(bootstrap).toContain(
      "REVOKE SELECT, INSERT ON ${database}.clickhouse_schema_migrations",
    );
    expect(bootstrap).toContain(
      "REVOKE SELECT, INSERT ON ${database}.__clickhouse_schema_migration_lock",
    );
    expect(bootstrap).toContain("ai_control_migration_role");
    expect(bootstrap).toContain("ALTER TABLE");
    expect(bootstrap).toContain("DROP TABLE");
    expect(bootstrap).not.toMatch(/(?:^|, )ALTER(?:,| ON)/mu);
    expect(bootstrap).not.toMatch(/(?:^|, )DROP(?:,| ON)/mu);
    expect(bootstrap).toContain("CREATE USER IF NOT EXISTS ${application_user}");
    expect(bootstrap).toContain("CREATE USER IF NOT EXISTS ${migration_user}");
    expect(bootstrap).toContain("must not use the privileged default account");
    expect(bootstrap).toContain("passwords must be distinct");
    expect(bootstrap).toContain("reserved database name");
  });

  it("persists only a bootstrap password digest in processed server config", async () => {
    const [entrypoint, defaultUserConfig] = await Promise.all([
      readFile(entrypointPath, "utf8"),
      readFile(defaultUserConfigPath, "utf8"),
    ]);

    expect(entrypoint).toContain("sha256sum");
    expect(entrypoint).not.toContain("echo $CLICKHOUSE_PASSWORD");
    expect(defaultUserConfig).toContain('<password remove="remove" />');
    expect(defaultUserConfig).toContain(
      '<password_sha256_hex from_env="AI_CONTROL_CLICKHOUSE_BOOTSTRAP_PASSWORD_SHA256_HEX" />',
    );
  });

  it("keeps the bootstrap password out of healthcheck process arguments", async () => {
    const [compose, healthcheck] = await Promise.all([
      readFile(composePath, "utf8"),
      readFile(healthcheckPath, "utf8"),
    ]);

    expect(compose).toContain(
      'test: ["CMD", "/usr/local/bin/tokenpilot-clickhouse-healthcheck.sh"]',
    );
    expect(compose).not.toContain('--password "$${CLICKHOUSE_PASSWORD}"');
    expect(healthcheck).toContain('chmod 600 "$client_config"');
    expect(healthcheck).toContain('--config-file "$client_config"');
  });
});

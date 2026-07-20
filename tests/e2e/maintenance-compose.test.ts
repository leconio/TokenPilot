import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("maintenance Compose boundary", () => {
  it("rejects PostgreSQL catalog drift after applying the current migrations", async () => {
    const start = await readFile("deploy/docker/start.sh", "utf8");
    const compose = await readFile("deploy/docker-compose.yml", "utf8");
    const migrateConfig = await readFile("apps/migrate/prisma.config.ts", "utf8");
    expect(start).toContain("migrate deploy --config prisma.config.ts");
    expect(start).toContain("migrate diff");
    expect(start).toContain("--from-migrations ../../packages/db/prisma/migrations");
    expect(start).toContain("--to-config-datasource");
    expect(start).toContain("--exit-code");
    expect(start).toContain("exit 78");
    expect(compose).toContain("SHADOW_DATABASE_URL:");
    expect(compose).toContain("@postgres:5432/postgres");
    expect(migrateConfig).toContain("shadowDatabaseUrl");
  });

  it("provides opt-in non-root PostgreSQL tooling without application secrets", async () => {
    const compose = await readFile("deploy/docker-compose.maintenance.yml", "utf8");
    expect(compose).toContain("profiles: [maintenance]");
    expect(compose).toContain('user: "1000:1000"');
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("cap_drop: [ALL]");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toContain("BACKUP_HOST_PATH:?");
    expect(compose).toContain("DATABASE_URL:");
    expect(compose).not.toContain("env_file:");
    expect(compose).not.toContain("INGEST_API_KEY");
    expect(compose).not.toContain("POLICY_API_KEY");
    expect(compose).not.toContain("ADMIN_API_KEY");
    expect(compose).not.toContain("ADMIN_INITIAL_PASSWORD");
    expect(compose).not.toContain("API_KEY_PEPPER");
  });
});

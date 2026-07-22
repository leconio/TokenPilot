import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("maintenance operations runbook", () => {
  it("documents the direct root Compose lifecycle and isolated restore rule", async () => {
    const runbook = await readFile("docs/operations.md", "utf8");
    const deployment = await readFile("docs/deployment.md", "utf8");

    expect(deployment).toContain("docker compose up -d --build --wait");
    expect(deployment).toContain("docker compose down --volumes --remove-orphans");
    expect(runbook).toContain("not the active project");
    expect(runbook).toContain("new isolated Compose project");
  });

  it("documents private ingress and datastore exposure", async () => {
    const runbook = await readFile("docs/operations.md", "utf8");
    const deployment = await readFile("docs/deployment.md", "utf8");

    expect(deployment).toContain("CADDY_BIND_ADDRESS=127.0.0.1");
    expect(deployment).toContain("Do not publish ports 5432, 6379, 8123, or 9000");
    expect(runbook).toContain("This retains volumes");
  });

  it("keeps database credentials out of host command arguments and output", async () => {
    const runbook = await readFile("docs/operations.md", "utf8");

    expect(runbook).toContain("./scripts/backup-postgres.sh --output /secure/backups");
    expect(runbook).toContain("./scripts/operations/backup-clickhouse.sh");
    expect(runbook).toContain("./scripts/operations/backup-redis.sh");
    expect(runbook).not.toMatch(/--database-url\s+['"]postgresql:/u);
    expect(runbook).not.toMatch(/--target-url\s+['"]postgresql:/u);
  });

  it("keeps product analytics out of the PostgreSQL integrity snapshot", async () => {
    const snapshot = await readFile("scripts/usage-snapshot.sh", "utf8");

    expect(snapshot).toContain("'scope', 'postgresql_transactional_authority'");
    expect(snapshot).toContain("'analytics_store', 'clickhouse'");
    expect(snapshot).not.toMatch(/sum\s*\(/iu);
    expect(snapshot).not.toContain("'model_cost'");
    expect(snapshot).not.toContain("'aiu_usage'");
    expect(snapshot).not.toContain("'user_quota'");
  });
});

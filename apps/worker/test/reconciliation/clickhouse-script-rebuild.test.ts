import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FreshClickHouseRebuildPlan } from "@tokenpilot/reconciliation-engine";

import { ClickHouseScriptRebuildExecutor } from "../../src/reconciliation/clickhouse-script-rebuild.js";

const runId = "d4f14052-7237-4e0c-8619-392140c124a4";
const plan: FreshClickHouseRebuildPlan = {
  rebuildId: runId,
  database: "ai_control_acceptance_20260717010101abc123",
  steps: [
    "clear_isolated_database",
    "create_current_schema",
    "replay_postgresql_outbox",
    "verify_current_projection",
  ],
};
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("ClickHouseScriptRebuildExecutor", () => {
  it("fails explicitly when the least-privilege Worker has no operator DDL grant", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fresh-rebuild-worker-"));
    directories.push(directory);
    const executor = new ClickHouseScriptRebuildExecutor({
      evidenceDirectory: directory,
      environment: {},
    });

    await expect(
      executor.execute(plan, { runId, reason: "repair the isolated analytical projection" }),
    ).rejects.toThrow(/operator-run release tooling/u);
  });

  it("passes the exact fresh plan to explicitly authorized one-shot tooling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fresh-rebuild-worker-"));
    directories.push(directory);
    const runCommand = vi.fn().mockResolvedValue({
      stdout: `${JSON.stringify({ status: "passed", mode: "fresh_only" })}\n`,
    });
    const executor = new ClickHouseScriptRebuildExecutor({
      evidenceDirectory: directory,
      workspaceRoot: "/workspace",
      environment: {
        CLICKHOUSE_FRESH_REBUILD_ALLOWED: "true",
        CLICKHOUSE_MIGRATION_USERNAME: "isolated_migrator",
        CLICKHOUSE_MIGRATION_PASSWORD: "isolated-migration-password",
      },
      runCommand,
    });

    await expect(
      executor.execute(plan, { runId, reason: "repair the isolated analytical projection" }),
    ).resolves.toMatchObject({ status: "passed", mode: "fresh_only" });
    const arguments_ = runCommand.mock.calls[0]?.[1] as readonly string[];
    expect(arguments_[0]).toBe("/workspace/scripts/release/clickhouse-fresh-rebuild.mjs");
    expect(arguments_).toContain("--acknowledge-fresh-database");
    expect(arguments_).not.toContain("--sink-paused");
    const persisted = JSON.parse(await readFile(join(directory, `${runId}.plan.json`), "utf8"));
    expect(persisted).toEqual(plan);
  });
});

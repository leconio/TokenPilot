import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("data-plane runtime wiring", () => {
  it("keeps fresh rebuild DDL outside the continuously running Worker", async () => {
    const source = await readFile(new URL("../src/data-plane-runtime.ts", import.meta.url), "utf8");

    expect(source).toMatch(
      /const usagePipelinePoller = new SerialPoller\(\{\s*name: "usage-pipeline"/u,
    );
    expect(source).toMatch(
      /const clickHouseOutboxPoller = new SerialPoller\(\{\s*name: "clickhouse-outbox"/u,
    );
    expect(source).not.toMatch(
      /const clickHouseOutboxPoller = new SerialPoller\(\{\s*name: "usage-pipeline"/u,
    );
    expect(source).not.toContain("flags.clickhouse");
    expect(source).toContain("ClickHouse is required but unavailable");
    expect(source).not.toContain("ClickHouseSinkPauseCoordinator");
    expect(source).toContain("new ClickHouseScriptRebuildExecutor({");
    expect(source).not.toContain("CLICKHOUSE_MIGRATION_PASSWORD");
  });

  it("creates one mandatory ClickHouse client in main and injects it into every Worker reader", async () => {
    const [main, runtime] = await Promise.all([
      readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/data-plane-runtime.ts", import.meta.url), "utf8"),
    ]);

    expect(main).toContain("const clickhouseConfig = loadClickHouseConfig(process.env)");
    expect(main).toContain("const clickhouse = createClickHouseClient(clickhouseConfig)");
    expect(main).toContain("const clickhouseHealth = await checkClickHouseHealth(clickhouse)");
    expect(main).toContain("ClickHouse is required but unavailable");
    expect(main).toMatch(
      /new OperationalProcessor\(database, \{\s*clickhouse,\s*exportDirectory: environment\.EXPORT_DIRECTORY/u,
    );
    expect(main).toMatch(
      /createDataPlaneRuntime\(\{\s*database,\s*redis,\s*clickhouse,\s*clickhouseConfig/u,
    );
    expect(runtime).not.toContain("loadClickHouseConfig(process.env)");
    expect(runtime).not.toContain("createClickHouseClient(");
  });
});

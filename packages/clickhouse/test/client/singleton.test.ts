import type { ClickHouseClient } from "@clickhouse/client";
import { describe, expect, it, vi } from "vitest";

import {
  ClickHouseClientRegistry,
  ClickHouseConfigurationError,
  loadClickHouseConfig,
} from "../../src/index.js";

function config(timeout = "10000") {
  return loadClickHouseConfig({
    CLICKHOUSE_PASSWORD: "unit-test-password",
    CLICKHOUSE_REQUEST_TIMEOUT_MS: timeout,
  });
}

describe("ClickHouse client singleton registry", () => {
  it("creates one official client per credential role and closes it once", async () => {
    const applicationClose = vi.fn().mockResolvedValue(undefined);
    const migrationClose = vi.fn().mockResolvedValue(undefined);
    const applicationClient = { close: applicationClose } as unknown as ClickHouseClient;
    const migrationClient = { close: migrationClose } as unknown as ClickHouseClient;
    const factory = vi
      .fn()
      .mockReturnValueOnce(applicationClient)
      .mockReturnValueOnce(migrationClient);
    const registry = new ClickHouseClientRegistry(factory);

    expect(registry.get(config(), "application")).toBe(applicationClient);
    expect(registry.get(config(), "application")).toBe(applicationClient);
    expect(registry.get(config(), "migration")).toBe(migrationClient);
    expect(factory).toHaveBeenCalledTimes(2);

    await registry.close();
    expect(applicationClose).toHaveBeenCalledOnce();
    expect(migrationClose).toHaveBeenCalledOnce();
  });

  it("rejects reconfiguration of an active singleton", () => {
    const registry = new ClickHouseClientRegistry(
      () => ({ close: vi.fn() }) as unknown as ClickHouseClient,
    );
    registry.get(config(), "application");

    expect(() => registry.get(config("20000"), "application")).toThrowError(
      ClickHouseConfigurationError,
    );
  });
});

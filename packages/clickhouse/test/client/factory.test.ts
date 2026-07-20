import { describe, expect, it, vi } from "vitest";

const { officialCreate } = vi.hoisted(() => ({
  officialCreate: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock("@clickhouse/client", () => ({
  ClickHouseLogLevel: { OFF: 127 },
  createClient: officialCreate,
}));

import { createClickHouseClient } from "../../src/client.js";
import { loadClickHouseConfig } from "../../src/config.js";
import { ClickHouseConfigurationError } from "../../src/errors.js";

describe("official ClickHouse client factory", () => {
  it("passes bounded pooling, timeout, credentials, and confirmed async settings", () => {
    const config = loadClickHouseConfig({
      CLICKHOUSE_URL: "https://clickhouse.example.test:8443",
      CLICKHOUSE_SECURE: "true",
      CLICKHOUSE_USERNAME: "runtime_reader_writer",
      CLICKHOUSE_PASSWORD: "unit-test-password",
      CLICKHOUSE_MAX_OPEN_CONNECTIONS: "17",
      CLICKHOUSE_REQUEST_TIMEOUT_MS: "2345",
    });

    createClickHouseClient(config);

    expect(officialCreate).toHaveBeenCalledWith({
      url: "https://clickhouse.example.test:8443",
      username: "runtime_reader_writer",
      password: "unit-test-password",
      database: "ai_control_plane",
      request_timeout: 2345,
      max_open_connections: 17,
      application: "tokenpilot",
      log: { level: 127 },
      clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
    });
  });

  it("refuses to load credential-free client configuration", () => {
    expect(() => loadClickHouseConfig({})).toThrowError(ClickHouseConfigurationError);
  });
});

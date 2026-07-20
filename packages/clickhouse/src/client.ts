import {
  ClickHouseLogLevel,
  createClient as createOfficialClient,
  type ClickHouseClient,
} from "@clickhouse/client";

import type { ClickHouseRuntimeConfig } from "./config.js";
import { ClickHouseConfigurationError } from "./errors.js";

export function createClickHouseClient(config: ClickHouseRuntimeConfig): ClickHouseClient {
  if (config.password.length === 0) {
    throw new ClickHouseConfigurationError(
      "ClickHouse password must not be empty when creating a client",
    );
  }

  return createOfficialClient({
    url: config.url,
    username: config.username,
    password: config.password,
    database: config.database,
    request_timeout: config.requestTimeoutMs,
    max_open_connections: config.maxOpenConnections,
    application: "tokenpilot",
    log: { level: ClickHouseLogLevel.OFF },
    clickhouse_settings: {
      async_insert: config.asyncInsert ? 1 : 0,
      wait_for_async_insert: config.waitForAsyncInsert ? 1 : 0,
    },
  });
}

export type { ClickHouseClient } from "@clickhouse/client";

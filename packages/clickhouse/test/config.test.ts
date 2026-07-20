import { describe, expect, it } from "vitest";

import {
  ClickHouseConfigurationError,
  loadClickHouseConfig,
  publicClickHouseConfig,
  sanitizeClickHouseError,
} from "../src/index.js";

describe("ClickHouse configuration", () => {
  it("requires credentials by default", () => {
    expect(() => loadClickHouseConfig({})).toThrowError(ClickHouseConfigurationError);

    const config = loadClickHouseConfig({ CLICKHOUSE_PASSWORD: "not-a-real-password" });

    expect(config).toMatchObject({
      url: "http://clickhouse:8123",
      database: "ai_control_plane",
      username: "ai_control_app",
      password: "not-a-real-password",
      asyncInsert: true,
      waitForAsyncInsert: true,
      maxOpenConnections: 10,
      safeRetryAttempts: 3,
    });
  });

  it("loads migration credentials without asynchronous inserts", () => {
    const config = loadClickHouseConfig(
      {
        CLICKHOUSE_MIGRATION_USERNAME: "migration_user",
        CLICKHOUSE_MIGRATION_PASSWORD: "not-a-real-password",
      },
      { role: "migration" },
    );

    expect(config.username).toBe("migration_user");
    expect(config.asyncInsert).toBe(false);
    expect(config.waitForAsyncInsert).toBe(true);
  });

  it("never exposes a password in public configuration", () => {
    const config = loadClickHouseConfig({
      CLICKHOUSE_PASSWORD: "not-a-real-password",
    });

    expect(publicClickHouseConfig(config)).not.toHaveProperty("password");
    expect(JSON.stringify(publicClickHouseConfig(config))).not.toContain("not-a-real-password");
  });

  it.each([
    [{ CLICKHOUSE_URL: "ftp://clickhouse" }, "http or https"],
    [{ CLICKHOUSE_URL: "http://user:secret@clickhouse:8123" }, "must not embed credentials"],
    [
      { CLICKHOUSE_URL: "http://clickhouse:8123?password=secret" },
      "must not contain query parameters",
    ],
    [{ CLICKHOUSE_URL: "http://clickhouse:8123/system" }, "must not embed a database"],
    [{ CLICKHOUSE_PASSWORD: "short" }, "16-256 URL-safe"],
    [{ CLICKHOUSE_PASSWORD: `invalid space ${"x".repeat(16)}` }, "16-256 URL-safe"],
    [{ CLICKHOUSE_SECURE: "true", CLICKHOUSE_URL: "http://clickhouse:8123" }, "must match"],
    [{ CLICKHOUSE_DATABASE: "unsafe-name" }, "identifier"],
    [{ CLICKHOUSE_DATABASE: "system" }, "reserved database"],
    [{ CLICKHOUSE_USERNAME: "default" }, "least-privilege"],
    [{ CLICKHOUSE_REQUEST_TIMEOUT_MS: "0" }, "between 1"],
    [
      { CLICKHOUSE_ASYNC_INSERT: "true", CLICKHOUSE_WAIT_FOR_ASYNC_INSERT: "false" },
      "must be true when asynchronous inserts are enabled",
    ],
    [
      {
        CLICKHOUSE_USERNAME: "same_user",
        CLICKHOUSE_MIGRATION_USERNAME: "same_user",
      },
      "credentials must be distinct",
    ],
    [
      {
        CLICKHOUSE_PASSWORD: "same-password-value",
        CLICKHOUSE_MIGRATION_PASSWORD: "same-password-value",
      },
      "credentials must be distinct",
    ],
  ])("rejects invalid environment %#", (environment, message) => {
    expect(() =>
      loadClickHouseConfig({ CLICKHOUSE_PASSWORD: "not-a-real-password", ...environment }),
    ).toThrowError(message);
  });

  it("requires a password unconditionally", () => {
    expect(() => loadClickHouseConfig({})).toThrowError(ClickHouseConfigurationError);
  });

  it("redacts credentials embedded in an upstream error", () => {
    expect(
      sanitizeClickHouseError(
        new Error("request to http://admin:top-secret@clickhouse:8123 failed"),
      ),
    ).toBe("request to http://[redacted]@[redacted] failed");
    expect(
      sanitizeClickHouseError(new Error("password=secret access_token:token-value refused")),
    ).toBe("password=[redacted] access_token=[redacted] refused");
  });
});

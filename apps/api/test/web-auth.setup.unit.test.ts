import type { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseClient } from "@tokenpilot/db";

import type { ApiConfiguration } from "../src/api-config.js";
import { WebAuthService } from "../src/web-auth.service.js";

const configuration: ApiConfiguration = {
  instanceId: "setup-test-01",
  environment: "test",
  timezone: "Asia/Shanghai",
  baseCurrency: "USD",
  webBaseUrl: "http://127.0.0.1:3000",
  databaseUrl: "postgresql://invalid/setup-test",
  redisUrl: "redis://127.0.0.1:6379/15",
  clickhouseDatabase: "setup_test",
  apiKeyPepper: "setup-test-api-key-pepper-000000001",
  port: 4000,
  logLevel: "silent",
  maxBatchSize: 500,
  maxCompressedBytes: 1_048_576,
  maxDecompressedBytes: 5_242_880,
  requestTimeoutMs: 10_000,
  rateLimitMax: 10,
  loginRateLimitMax: 3,
  loginRateLimitWindowSeconds: 900,
  connectorStaleAfterSeconds: 120,
  connectorBacklogAlertDepth: 1000,
};

function setupDatabase(options: { failKey?: boolean } = {}) {
  const transaction = {
    user: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000001",
        name: "Administrator",
        email: "admin@example.test",
      }),
    },
    account: { create: vi.fn().mockResolvedValue({}) },
    application: {
      create: vi.fn().mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000002",
        name: "Support",
        slug: "support",
      }),
    },
    applicationApiKey: {
      create: options.failKey
        ? vi.fn().mockRejectedValue(new Error("key persistence failed"))
        : vi.fn().mockImplementation(({ data }) => ({
            id: "00000000-0000-4000-8000-000000000003",
            keyPrefix: data.keyPrefix,
          })),
    },
    session: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const database = {
    $transaction: vi.fn().mockImplementation(async (operation) => operation(transaction)),
  } as unknown as DatabaseClient;
  return { database, transaction };
}

describe("first-run setup", () => {
  it("creates the administrator, application, access key, and Web session in one transaction", async () => {
    const { database, transaction } = setupDatabase();
    const auth = new WebAuthService(database, configuration, {} as Redis);

    const result = await auth.initialize(
      {
        name: "Administrator",
        email: "admin@example.test",
        password: "StrongPassword123!",
        application_name: "Support",
      },
      "192.0.2.10",
      "setup-test-agent",
    );

    expect(result).toMatchObject({
      initialized: true,
      application: { slug: "support" },
      access_key: {
        id: "00000000-0000-4000-8000-000000000003",
        key_prefix: expect.stringMatching(/^tp_/u),
        api_key: expect.stringMatching(/^tp_[a-f\d]{64}$/u),
      },
      session: {
        token: expect.any(String),
        csrf: expect.any(String),
        expiresAt: expect.any(Date),
      },
    });
    expect(transaction.applicationApiKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationId: "00000000-0000-4000-8000-000000000002",
        scopes: [
          "usage:write",
          "connector:heartbeat",
          "runtime:read",
          "runtime:write",
          "runtime:ack",
        ],
      }),
      select: { id: true, keyPrefix: true },
    });
    expect(transaction.session.create).toHaveBeenCalledOnce();
    expect(transaction.auditLog.create).toHaveBeenCalledTimes(2);
  });

  it("does not create a session when access-key persistence fails", async () => {
    const { database, transaction } = setupDatabase({ failKey: true });
    const auth = new WebAuthService(database, configuration, {} as Redis);

    await expect(
      auth.initialize({
        name: "Administrator",
        email: "admin@example.test",
        password: "StrongPassword123!",
        application_name: "Support",
      }),
    ).rejects.toThrow("key persistence failed");
    expect(transaction.session.create).not.toHaveBeenCalled();
  });
});

import type { ApiConfiguration } from "../../../src/api-config.js";

export const enabled = process.env.TEST_DATABASE_URL !== undefined;
export const adminDatabaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://invalid/disabled";
export const redisUrl = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/15";
export const databaseName = `ai_control_current_integration_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(adminDatabaseUrl);
databaseUrl.pathname = `/${databaseName}`;

export const ingestKey = "current-integration-ingest-key-00000001";
export const policyKey = "current-integration-policy-key-00000001";
export const adminKey = "current-integration-admin-key-000000001";
export const applicationName = "Current Integration";
export const applicationSlug = "current-integration";

export const configuration: ApiConfiguration = {
  instanceId: "current-api-01",
  environment: "test",
  timezone: "Asia/Shanghai",
  baseCurrency: "USD",
  webBaseUrl: "http://127.0.0.1:3000",
  databaseUrl: databaseUrl.toString(),
  redisUrl,
  clickhouseDatabase: "ai_control_plane_test",
  apiKeyPepper: "current-integration-pepper-value-00000001",
  port: 4000,
  logLevel: "silent",
  maxBatchSize: 500,
  maxCompressedBytes: 2_000_000,
  maxDecompressedBytes: 3_000_000,
  requestTimeoutMs: 10_000,
  rateLimitMax: 1_000,
  loginRateLimitMax: 3,
  loginRateLimitWindowSeconds: 900,
  connectorStaleAfterSeconds: 60,
  connectorBacklogAlertDepth: 5,
};

export function migrationEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: configuration.databaseUrl,
  };
}

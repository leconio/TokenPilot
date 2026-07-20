import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  loadDatabaseEnvironment,
  loadEnvironment,
  loadFeatureFlagOperatorEnvironment,
  loadSchedulerEnvironment,
  loadWorkerEnvironment,
} from "../src/environment.js";

const validEnvironment = {
  INSTANCE_ID: "demo-development-01",
  ENVIRONMENT: "development",
  APP_TIMEZONE: "Asia/Shanghai",
  BASE_CURRENCY: "USD",
  DATABASE_URL: "postgresql://user:password@postgres:5432/ai_control",
  REDIS_URL: "redis://redis:6379",
  WEB_BASE_URL: "http://localhost:3000",
  API_BASE_URL: "http://localhost:4000",
  API_KEY_PEPPER: "replace-before-use-api-key-pepper-0001",
  CLICKHOUSE_PASSWORD: "clickhouse-runtime-password",
  STORE_PROMPT_CONTENT: "false",
  STORE_RESPONSE_CONTENT: "false",
  RAW_EVENT_RETENTION_DAYS: "90",
} satisfies Record<string, string>;

describe("loadEnvironment", () => {
  it("returns strongly typed values", () => {
    const environment = loadEnvironment(validEnvironment);
    expect(environment.STORE_PROMPT_CONTENT).toBe(false);
    expect(environment.WEB_SESSION_COOKIE_SECURE).toBeUndefined();
    expect(environment.RAW_EVENT_RETENTION_DAYS).toBe(90);
    expect(environment).toMatchObject({
      FEATURE_USAGE_PIPELINE: false,
      FEATURE_MODEL_CATALOG: false,
      FEATURE_AIU: false,
      FEATURE_QUOTA: false,
      FEATURE_HARD_LIMIT: false,
      FEATURE_RECONCILIATION: false,
      CLICKHOUSE_URL: "http://clickhouse:8123",
      CLICKHOUSE_DATABASE: "ai_control_plane",
      CLICKHOUSE_USERNAME: "ai_control_app",
      CLICKHOUSE_PASSWORD: "clickhouse-runtime-password",
      AIU_ENABLED: false,
      AIU_MODE: "disabled",
      AIU_MICRO_SCALE: 1_000_000,
      DIMENSION_MAX_KEYS: 32,
      INBOX_PAYLOAD_RETENTION_DAYS: 14,
      CH_SINK_MAX_RETRIES: 20,
      RECON_COST_TOLERANCE: "0.000001",
      RECON_AIU_MICRO_TOLERANCE: 0,
    });
  });

  it("accepts only explicit boolean session-cookie transport settings", () => {
    expect(
      loadEnvironment({ ...validEnvironment, WEB_SESSION_COOKIE_SECURE: "false" })
        .WEB_SESSION_COOKIE_SECURE,
    ).toBe(false);
    expect(() =>
      loadEnvironment({ ...validEnvironment, WEB_SESSION_COOKIE_SECURE: "sometimes" }),
    ).toThrow();
  });

  it("fails explicitly when required configuration is missing", () => {
    const missingDatabase: Record<string, string> = { ...validEnvironment };
    delete missingDatabase.DATABASE_URL;
    expect(() => loadEnvironment(missingDatabase)).toThrow();
  });

  it("rejects unsafe short secrets", () => {
    expect(() => loadEnvironment({ ...validEnvironment, API_KEY_PEPPER: "short" })).toThrow();
  });

  it("never imports the LiteLLM master key into Control Plane configuration", () => {
    const environment = loadEnvironment({
      ...validEnvironment,
      LITELLM_MASTER_KEY: "provider-boundary-sentinel",
    });
    expect("LITELLM_MASTER_KEY" in environment).toBe(false);
    expect(JSON.stringify(environment)).not.toContain("provider-boundary-sentinel");
  });

  it("strictly rejects inconsistent runtime and feature settings", () => {
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        CLICKHOUSE_PASSWORD: undefined,
      }),
    ).toThrow();
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        CLICKHOUSE_USERNAME: "default",
      }),
    ).toThrow(/least-privilege account/u);
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        CLICKHOUSE_DATABASE: "system",
      }),
    ).toThrow(/reserved database/u);
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        CLICKHOUSE_URL: "http://embedded:credential@clickhouse:8123",
      }),
    ).toThrow(/must not embed credentials/u);
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        CLICKHOUSE_URL: "http://clickhouse:8123?password=credential",
      }),
    ).toThrow(/must not contain query parameters/u);
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        CLICKHOUSE_URL: "not-a-url",
      }),
    ).toThrow(ZodError);
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        CLICKHOUSE_URL: "https://clickhouse:8443",
        CLICKHOUSE_SECURE: "false",
      }),
    ).toThrow(/CLICKHOUSE_SECURE must match/u);
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        CLICKHOUSE_ASYNC_INSERT: "false",
        CLICKHOUSE_WAIT_FOR_ASYNC_INSERT: "true",
      }),
    ).toThrow(/WAIT_FOR_ASYNC_INSERT/u);
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        AIU_ENABLED: "true",
        AIU_MODE: "disabled",
      }),
    ).toThrow(/AIU_ENABLED=true requires an active AIU_MODE/u);
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        FEATURE_QUOTA: "true",
      }),
    ).toThrow(/FEATURE_QUOTA requires FEATURE_AIU/u);
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        RECON_COST_TOLERANCE: "1e-6",
      }),
    ).toThrow();
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        DIMENSION_MAX_TOTAL_BYTES: "128",
      }),
    ).toThrow(/must fit at least one maximum key\/value pair/u);

    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        CLICKHOUSE_PASSWORD: "application-secret",
      }),
    ).not.toThrow();
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        CLICKHOUSE_PASSWORD: "short",
      }),
    ).toThrow(/16-256 URL-safe/u);
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        CLICKHOUSE_PASSWORD: `valid-length-but-space ${"x".repeat(16)}`,
      }),
    ).toThrow(/16-256 URL-safe/u);
  });

  it("does not echo the ClickHouse password in validation errors", () => {
    const password = "clickhouse-password-boundary-sentinel";
    let caught: unknown;
    try {
      loadEnvironment({
        ...validEnvironment,
        CLICKHOUSE_PASSWORD: password,
        CLICKHOUSE_SECURE: "true",
        CLICKHOUSE_URL: "http://clickhouse:8123",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(JSON.stringify(caught)).not.toContain(password);
  });
});

const forbiddenRuntimeSecrets = {
  ADMIN_INITIAL_PASSWORD: "admin-boundary-sentinel",
  INGEST_API_KEY: "ingest-boundary-sentinel",
  POLICY_API_KEY: "policy-boundary-sentinel",
  ADMIN_API_KEY: "admin-api-boundary-sentinel",
  API_KEY_PEPPER: "pepper-boundary-sentinel-value-0001",
  LITELLM_MASTER_KEY: "litellm-boundary-sentinel",
  OPENAI_API_KEY: "provider-boundary-sentinel",
};

describe("least-privilege runtime environment loaders", () => {
  it("loads only Worker-owned settings, including safe runtime defaults", () => {
    const environment = loadWorkerEnvironment({
      INSTANCE_ID: validEnvironment.INSTANCE_ID,
      ENVIRONMENT: validEnvironment.ENVIRONMENT,
      DATABASE_URL: validEnvironment.DATABASE_URL,
      REDIS_URL: validEnvironment.REDIS_URL,
      BASE_CURRENCY: "EUR",
      CLICKHOUSE_PASSWORD: validEnvironment.CLICKHOUSE_PASSWORD,
      CONNECTOR_STALE_AFTER_SECONDS: "180",
      EXPORT_DIRECTORY: "/var/lib/tokenpilot/exports",
      WORKER_METRICS_HOST: "127.0.0.1",
      WORKER_METRICS_PORT: "9465",
      RECONCILIATION_USER_HMAC_SECRET: "reconciliation-user-hmac-secret-0000001",
      FEATURE_AIU: "true",
      FEATURE_QUOTA: "true",
      ...forbiddenRuntimeSecrets,
    });

    expect(environment).toMatchObject({
      INSTANCE_ID: validEnvironment.INSTANCE_ID,
      ENVIRONMENT: validEnvironment.ENVIRONMENT,
      DATABASE_URL: validEnvironment.DATABASE_URL,
      REDIS_URL: validEnvironment.REDIS_URL,
      BASE_CURRENCY: "EUR",
      CONNECTOR_STALE_AFTER_SECONDS: 180,
      EXPORT_DIRECTORY: "/var/lib/tokenpilot/exports",
      WORKER_METRICS_HOST: "127.0.0.1",
      WORKER_METRICS_PORT: 9465,
      PIPELINE_POLL_INTERVAL_MS: 250,
      CLICKHOUSE_OUTBOX_POLL_INTERVAL_MS: 500,
      INBOX_PAYLOAD_CLEANUP_INTERVAL_MS: 300_000,
      INBOX_PAYLOAD_CLEANUP_BATCH_SIZE: 500,
      AIU_RESERVATION_SWEEP_INTERVAL_MS: 30_000,
      AIU_RESERVATION_SWEEP_BATCH_SIZE: 100,
      CLICKHOUSE_USERNAME: "ai_control_app",
      CLICKHOUSE_PASSWORD: validEnvironment.CLICKHOUSE_PASSWORD,
      AIU_MODE: "disabled",
      AIU_MICRO_SCALE: 1_000_000,
      RECONCILIATION_USER_HMAC_SECRET: "reconciliation-user-hmac-secret-0000001",
    });
    expect("FEATURE_AIU" in environment).toBe(false);
    expect("FEATURE_QUOTA" in environment).toBe(false);
    expect(JSON.stringify(environment)).not.toContain("boundary-sentinel");
  });

  it("fails Worker startup when a required setting is missing or malformed", () => {
    expect(() =>
      loadWorkerEnvironment({
        INSTANCE_ID: validEnvironment.INSTANCE_ID,
        ENVIRONMENT: validEnvironment.ENVIRONMENT,
        DATABASE_URL: validEnvironment.DATABASE_URL,
        REDIS_URL: validEnvironment.REDIS_URL,
        BASE_CURRENCY: validEnvironment.BASE_CURRENCY,
        WORKER_METRICS_PORT: "0",
      }),
    ).toThrow();
    expect(() =>
      loadWorkerEnvironment({
        INSTANCE_ID: validEnvironment.INSTANCE_ID,
        ENVIRONMENT: validEnvironment.ENVIRONMENT,
        REDIS_URL: validEnvironment.REDIS_URL,
        BASE_CURRENCY: validEnvironment.BASE_CURRENCY,
      }),
    ).toThrow();
  });

  it("validates Worker identity and bounded polling intervals", () => {
    const required = {
      INSTANCE_ID: validEnvironment.INSTANCE_ID,
      ENVIRONMENT: "production",
      DATABASE_URL: validEnvironment.DATABASE_URL,
      REDIS_URL: validEnvironment.REDIS_URL,
      BASE_CURRENCY: validEnvironment.BASE_CURRENCY,
      CLICKHOUSE_PASSWORD: validEnvironment.CLICKHOUSE_PASSWORD,
    };
    expect(
      loadWorkerEnvironment({
        ...required,
        PIPELINE_POLL_INTERVAL_MS: "100",
        CLICKHOUSE_OUTBOX_POLL_INTERVAL_MS: "750",
        INBOX_PAYLOAD_CLEANUP_INTERVAL_MS: "2000",
        INBOX_PAYLOAD_CLEANUP_BATCH_SIZE: "250",
        AIU_RESERVATION_SWEEP_INTERVAL_MS: "1500",
        AIU_RESERVATION_SWEEP_BATCH_SIZE: "50",
      }),
    ).toMatchObject({
      INSTANCE_ID: validEnvironment.INSTANCE_ID,
      ENVIRONMENT: "production",
      PIPELINE_POLL_INTERVAL_MS: 100,
      CLICKHOUSE_OUTBOX_POLL_INTERVAL_MS: 750,
      INBOX_PAYLOAD_CLEANUP_INTERVAL_MS: 2000,
      INBOX_PAYLOAD_CLEANUP_BATCH_SIZE: 250,
      AIU_RESERVATION_SWEEP_INTERVAL_MS: 1500,
      AIU_RESERVATION_SWEEP_BATCH_SIZE: 50,
    });
    expect(() => loadWorkerEnvironment({ ...required, PIPELINE_POLL_INTERVAL_MS: "0" })).toThrow();
    expect(() =>
      loadWorkerEnvironment({ ...required, CLICKHOUSE_OUTBOX_POLL_INTERVAL_MS: "60001" }),
    ).toThrow();
    expect(() =>
      loadWorkerEnvironment({ ...required, INBOX_PAYLOAD_CLEANUP_INTERVAL_MS: "999" }),
    ).toThrow();
    expect(() =>
      loadWorkerEnvironment({ ...required, INBOX_PAYLOAD_CLEANUP_BATCH_SIZE: "5001" }),
    ).toThrow();
    expect(() =>
      loadWorkerEnvironment({ ...required, AIU_RESERVATION_SWEEP_INTERVAL_MS: "999" }),
    ).toThrow();
    expect(() =>
      loadWorkerEnvironment({ ...required, AIU_RESERVATION_SWEEP_BATCH_SIZE: "1001" }),
    ).toThrow();
    expect(() => loadWorkerEnvironment({ ...required, INSTANCE_ID: "" })).toThrow();
    expect(() => loadWorkerEnvironment({ ...required, ENVIRONMENT: "unknown" })).toThrow();
    expect(() =>
      loadWorkerEnvironment({ ...required, RECONCILIATION_USER_HMAC_SECRET: "short" }),
    ).toThrow();
  });

  it("loads only REDIS_URL for Scheduler", () => {
    const environment = loadSchedulerEnvironment({
      REDIS_URL: validEnvironment.REDIS_URL,
      DATABASE_URL: validEnvironment.DATABASE_URL,
      CLICKHOUSE_PASSWORD: validEnvironment.CLICKHOUSE_PASSWORD,
      ...forbiddenRuntimeSecrets,
    });

    expect(environment).toEqual({ REDIS_URL: validEnvironment.REDIS_URL });
    expect(JSON.stringify(environment)).not.toContain("boundary-sentinel");
  });

  it("loads only DATABASE_URL for database-only CLIs", () => {
    const environment = loadDatabaseEnvironment({
      DATABASE_URL: validEnvironment.DATABASE_URL,
      REDIS_URL: validEnvironment.REDIS_URL,
      ...forbiddenRuntimeSecrets,
    });

    expect(environment).toEqual({ DATABASE_URL: validEnvironment.DATABASE_URL });
    expect(JSON.stringify(environment)).not.toContain("boundary-sentinel");
  });

  it("loads only database and current runtime settings for the feature-flag operator", () => {
    const environment = loadFeatureFlagOperatorEnvironment({
      DATABASE_URL: validEnvironment.DATABASE_URL,
      CLICKHOUSE_PASSWORD: validEnvironment.CLICKHOUSE_PASSWORD,
      // Stale creation defaults must not participate in an operator command.
      FEATURE_AIU: "true",
      FEATURE_QUOTA: "true",
      ...forbiddenRuntimeSecrets,
    });

    expect(environment).toMatchObject({
      DATABASE_URL: validEnvironment.DATABASE_URL,
      CLICKHOUSE_USERNAME: "ai_control_app",
      AIU_ENABLED: false,
      AIU_MODE: "disabled",
    });
    expect("REDIS_URL" in environment).toBe(false);
    expect("FEATURE_AIU" in environment).toBe(false);
    expect("FEATURE_QUOTA" in environment).toBe(false);
    expect(JSON.stringify(environment)).not.toContain("boundary-sentinel");
  });
});

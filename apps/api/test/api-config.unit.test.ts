import { loadEnvironment } from "@tokenpilot/shared";
import { describe, expect, it } from "vitest";

import { toApiConfiguration } from "../src/api-config.js";

const requiredEnvironment = {
  INSTANCE_ID: "test-instance",
  ENVIRONMENT: "test",
  APP_TIMEZONE: "UTC",
  BASE_CURRENCY: "USD",
  DATABASE_URL: "postgresql://user:password@postgres:5432/control",
  REDIS_URL: "redis://redis:6379",
  WEB_BASE_URL: "http://web:3000",
  API_BASE_URL: "http://api:4000",
  API_KEY_PEPPER: "api-key-pepper-replace-before-use-0001",
  LITELLM_BASE_URL: "http://litellm:4000",
  STORE_PROMPT_CONTENT: "false",
  STORE_RESPONSE_CONTENT: "false",
  RAW_EVENT_RETENTION_DAYS: "90",
  CLICKHOUSE_PASSWORD: "clickhouse-application-password-0001",
} satisfies Record<string, string>;

describe("API configuration", () => {
  it("maps the current application-user runtime configuration", () => {
    const configuration = toApiConfiguration(loadEnvironment(requiredEnvironment));
    expect(configuration).toMatchObject({
      clickhouseDatabase: "ai_control_plane",
      aiuMicroScale: 1_000_000,
      aiuReservationKeyVersion: "current",
      webSessionCookieSecure: false,
    });
    expect(configuration).not.toHaveProperty("billingContextSigningKey");
    expect(configuration).not.toHaveProperty("pseudonymizeEndUserId");
  });

  it("keeps production session cookies secure unless trusted HTTP is explicitly selected", () => {
    expect(
      toApiConfiguration(loadEnvironment({ ...requiredEnvironment, ENVIRONMENT: "production" }))
        .webSessionCookieSecure,
    ).toBe(true);
    expect(
      toApiConfiguration(
        loadEnvironment({
          ...requiredEnvironment,
          ENVIRONMENT: "production",
          WEB_SESSION_COOKIE_SECURE: "false",
        }),
      ).webSessionCookieSecure,
    ).toBe(false);
  });

  it("requires the deployment key-digest pepper", () => {
    expect(() => loadEnvironment({ ...requiredEnvironment, API_KEY_PEPPER: undefined })).toThrow();
    const configuration = toApiConfiguration(loadEnvironment(requiredEnvironment));
    expect(configuration.apiKeyPepper).toBe(requiredEnvironment.API_KEY_PEPPER);
    expect(configuration).not.toHaveProperty("ingestApiKey");
    expect(configuration).not.toHaveProperty("policyApiKey");
    expect(configuration).not.toHaveProperty("adminApiKey");
  });
});

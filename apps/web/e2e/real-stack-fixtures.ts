import { randomBytes } from "node:crypto";

import { expect, type APIRequestContext } from "@playwright/test";

export const enabled = process.env.REAL_STACK_E2E === "true";
export const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const virtualModel = "acceptance.chat";
export const acceptanceUserId = "acceptance-user";
export const acceptanceDisplayUser = "Acceptance user";

export interface AcceptanceEnvironment {
  readonly baseUrl: string;
  readonly litellmUrl: string;
  readonly applicationSlug: string;
  readonly email: string;
  readonly password: string;
  readonly masterKey?: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

export function acceptanceEnvironment(): AcceptanceEnvironment {
  if (process.env.REAL_STACK_E2E_ISOLATED !== "true") {
    throw new Error(
      "REAL_STACK_E2E_ISOLATED=true is required because this suite intentionally mutates data",
    );
  }
  const baseUrl = requiredEnvironment("PLAYWRIGHT_BASE_URL");
  const litellmUrl = requiredEnvironment("LITELLM_DEMO_URL");
  for (const [name, value] of [
    ["PLAYWRIGHT_BASE_URL", baseUrl],
    ["LITELLM_DEMO_URL", litellmUrl],
  ] as const) {
    const parsed = new URL(value);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
      throw new Error(`${name} must be an absolute HTTP(S) URL`);
    }
  }
  const masterKey = process.env.LITELLM_MASTER_KEY;
  return {
    baseUrl,
    litellmUrl,
    applicationSlug: requiredEnvironment("REAL_STACK_APPLICATION_SLUG"),
    email: requiredEnvironment("REAL_STACK_ADMIN_EMAIL"),
    password: requiredEnvironment("REAL_STACK_ADMIN_PASSWORD"),
    ...(masterKey === undefined || masterKey.length === 0 ? {} : { masterKey }),
  };
}

function encodeBase32(value: bigint, length: number): string {
  let remaining = value;
  let encoded = "";
  for (let index = 0; index < length; index += 1) {
    encoded = alphabet[Number(remaining & 31n)] + encoded;
    remaining >>= 5n;
  }
  return encoded;
}

export function freshUlid(): string {
  const entropy = randomBytes(10);
  let randomness = 0n;
  for (const byte of entropy) randomness = (randomness << 8n) | BigInt(byte);
  return `${encodeBase32(BigInt(Date.now()), 10)}${encodeBase32(randomness, 16)}`;
}

export async function verifyExternalIngress(
  request: APIRequestContext,
  environment: AcceptanceEnvironment,
): Promise<void> {
  const health = await request.get(new URL("/healthz", environment.baseUrl).toString());
  expect(health.status()).toBe(200);
  expect(health.headers()["x-content-type-options"]).toBe("nosniff");
  expect(health.headers()["x-frame-options"]).toBe("DENY");
  expect(health.headers()["server"]).toBeUndefined();
}

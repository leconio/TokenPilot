import type { ExecutionContext } from "@nestjs/common";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { scryptSync } from "node:crypto";
import type { Reflector } from "@nestjs/core";
import type { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";

import { hashApplicationApiKey, type DatabaseClient } from "@tokenpilot/db";

import { shouldSendStrictTransportSecurity, type ApiConfiguration } from "../src/api-config.js";
import { AuditService } from "../src/audit.service.js";
import { ApiKeyScopeGuard } from "../src/auth.js";
import { RateLimitExceededException } from "../src/rate-limit.js";
import { redactLogArguments, redactSensitiveData } from "../src/security.js";
import { WebAuthService } from "../src/web-auth.service.js";

const configuration: ApiConfiguration = {
  instanceId: "security-test-01",
  environment: "test",
  timezone: "UTC",
  baseCurrency: "USD",
  webBaseUrl: "https://control.example.test",
  databaseUrl: "postgresql://security:security@127.0.0.1:5432/security",
  redisUrl: "redis://127.0.0.1:6379/15",
  clickhouseDatabase: "ai_control_plane_test",
  apiKeyPepper: "security-api-key-pepper-000000000001",
  port: 4000,
  logLevel: "silent",
  maxBatchSize: 500,
  maxCompressedBytes: 1_048_576,
  maxDecompressedBytes: 5_242_880,
  requestTimeoutMs: 10_000,
  rateLimitMax: 10,
  loginRateLimitMax: 1,
  loginRateLimitWindowSeconds: 900,
  connectorStaleAfterSeconds: 120,
  connectorBacklogAlertDepth: 1000,
};

class FakeRedis {
  readonly values = new Map<string, number>();
  readonly expirations = new Map<string, number>();

  async get(key: string) {
    const value = this.values.get(key);
    return value === undefined ? null : String(value);
  }

  async incr(key: string) {
    const value = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, value);
    return value;
  }

  async expire(key: string, seconds: number) {
    this.expirations.set(key, seconds);
    return 1;
  }

  async ttl(key: string) {
    return this.expirations.get(key) ?? -1;
  }

  async del(...keys: string[]) {
    for (const key of keys) {
      this.values.delete(key);
      this.expirations.delete(key);
    }
    return keys.length;
  }
}

describe("security boundaries", () => {
  it("sends HSTS only for a production HTTPS origin", () => {
    expect(
      shouldSendStrictTransportSecurity({
        ...configuration,
        environment: "production",
        webBaseUrl: "https://control.example.test",
      }),
    ).toBe(true);
    expect(
      shouldSendStrictTransportSecurity({
        ...configuration,
        environment: "production",
        webBaseUrl: "http://192.168.51.207:15000",
      }),
    ).toBe(false);
    expect(shouldSendStrictTransportSecurity(configuration)).toBe(false);
  });

  it("marks Web session cookies secure only when the public origin uses HTTPS", () => {
    const plainHttp = new WebAuthService(
      {} as DatabaseClient,
      { ...configuration, environment: "production", webSessionCookieSecure: false },
      new FakeRedis() as unknown as Redis,
    );
    const https = new WebAuthService(
      {} as DatabaseClient,
      { ...configuration, environment: "production", webSessionCookieSecure: true },
      new FakeRedis() as unknown as Redis,
    );
    const expiresAt = new Date(Date.now() + 60_000);

    expect(plainHttp.cookieHeaders("session", "csrf", expiresAt).join(";")).not.toContain(
      "; Secure",
    );
    expect(
      https
        .cookieHeaders("session", "csrf", expiresAt)
        .every((header) => header.endsWith("; Secure")),
    ).toBe(true);
  });

  it("recursively redacts sensitive keys and credential-like values", () => {
    const sentinel = "sk-security-sentinel-value";
    const redacted = redactSensitiveData({
      safe: "preserved",
      metadata: { provider_key: sentinel },
      nested: [{ authorization: `Bearer ${sentinel}` }, `prefix ${sentinel} suffix`],
    });
    expect(redacted).toMatchObject({
      safe: "preserved",
      metadata: { provider_key: "[REDACTED]" },
    });
    expect(JSON.stringify(redacted)).not.toContain(sentinel);
    expect(
      JSON.stringify(redactLogArguments([{ note: sentinel }, `Bearer ${sentinel}`])),
    ).not.toContain(sentinel);
  });

  it("applies the same defensive redaction before audit persistence", async () => {
    const create = vi.fn().mockResolvedValue({});
    const audit = new AuditService({ auditLog: { create } } as unknown as DatabaseClient);
    const sentinel = "sk-audit-sentinel-value";
    await audit.record({
      action: "security.sentinel",
      objectType: "test",
      objectId: "test-1",
      before: { secret_ref: "OPENAI_API_KEY", metadata: { provider_key: sentinel } },
      after: { nested: { authorization: `Bearer ${sentinel}` } },
      reason: `rotate ${sentinel}`,
    });
    const persisted = create.mock.calls[0]?.[0];
    expect(persisted.data.beforeJson.secret_ref).toBe("OPENAI_API_KEY");
    expect(JSON.stringify(persisted)).not.toContain(sentinel);
    expect(JSON.stringify(persisted)).toContain("[REDACTED]");
  });

  it("requires same-origin evidence for authenticated writes and blocks cross-site pre-auth", () => {
    const auth = new WebAuthService(
      {} as DatabaseClient,
      configuration,
      new FakeRedis() as unknown as Redis,
    );
    expect(() => auth.assertPreAuthOrigin("https://attacker.example", "cross-site")).toThrow(
      ForbiddenException,
    );
    expect(() => auth.assertPreAuthOrigin(configuration.webBaseUrl, "same-origin")).not.toThrow();
    expect(() => auth.assertPreAuthOrigin(undefined, undefined)).not.toThrow();
    expect(() => auth.assertCsrf("cp_csrf=abcdefghijklmnop", "abcdefghijklmnop")).toThrow(
      ForbiddenException,
    );
    expect(() =>
      auth.assertCsrf(
        "cp_csrf=abcdefghijklmnop",
        "abcdefghijklmnop",
        configuration.webBaseUrl,
        "same-origin",
      ),
    ).not.toThrow();
    expect(() =>
      auth.assertCsrf(
        "cp_csrf=abcdefghijklmnop",
        "abcdefghijklmnop",
        configuration.webBaseUrl,
        "cross-site",
      ),
    ).toThrow(ForbiddenException);
  });

  it("rate-limits login by HMACed IP and email without placing either in Redis keys", async () => {
    const redis = new FakeRedis();
    const email = "sensitive@example.test";
    const ip = "203.0.113.42";
    const auth = new WebAuthService(
      { account: { findUnique: vi.fn().mockResolvedValue(null) } } as unknown as DatabaseClient,
      configuration,
      redis as unknown as Redis,
    );
    await expect(auth.login({ email, password: "wrong" }, ip)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(auth.login({ email, password: "wrong" }, ip)).rejects.toBeInstanceOf(
      RateLimitExceededException,
    );
    expect([...redis.values.keys()].join(" ")).not.toContain(email);
    expect([...redis.values.keys()].join(" ")).not.toContain(ip);
  });

  it("keeps an IP-wide login bucket when an attacker rotates candidate emails", async () => {
    const redis = new FakeRedis();
    const ip = "203.0.113.99";
    const auth = new WebAuthService(
      { account: { findUnique: vi.fn().mockResolvedValue(null) } } as unknown as DatabaseClient,
      configuration,
      redis as unknown as Redis,
    );
    await expect(
      auth.login({ email: "first@example.test", password: "wrong" }, ip),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      auth.login({ email: "second@example.test", password: "wrong" }, ip),
    ).rejects.toBeInstanceOf(RateLimitExceededException);
    expect([...redis.values.keys()].filter((key) => key.startsWith("login-rate:ip:"))).toHaveLength(
      1,
    );
  });

  it("clears login attempt buckets after successful authentication", async () => {
    const redis = new FakeRedis();
    const salt = Buffer.from("tokenpilot-login-test-salt");
    const password = "correct horse battery staple";
    const encodedPassword = `scrypt$${salt.toString("base64url")}$${scryptSync(password, salt, 64).toString("base64url")}`;
    const database = {
      account: {
        findUnique: vi.fn().mockResolvedValue({
          userId: "user-1",
          password: encodedPassword,
          user: { id: "user-1", name: "Administrator", email: "admin@example.test" },
        }),
      },
      session: {
        create: vi.fn().mockImplementation(({ data }) => ({ ...data, id: "session-1" })),
      },
    } as unknown as DatabaseClient;
    const auth = new WebAuthService(database, configuration, redis as unknown as Redis);

    await expect(
      auth.login({ email: "admin@example.test", password }, "203.0.113.7"),
    ).resolves.toMatchObject({ identity: { userId: "user-1" } });
    expect(redis.values.size).toBe(0);
    await expect(
      auth.login({ email: "admin@example.test", password }, "203.0.113.7"),
    ).resolves.toMatchObject({ identity: { userId: "user-1" } });
  });

  it("pre-auth rate-limits invalid Bearer keys by HMACed IP and returns retry metadata", async () => {
    const redis = new FakeRedis();
    const rawKey = "invalid-bearer-security-sentinel";
    const ip = "198.51.100.9";
    const database = {
      applicationApiKey: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as DatabaseClient;
    const guard = new ApiKeyScopeGuard(
      { get: vi.fn().mockReturnValue("usage:write") } as unknown as Reflector,
      database,
      redis as unknown as Redis,
      configuration,
      { authenticate: vi.fn().mockResolvedValue(null) } as unknown as WebAuthService,
    );
    const request = {
      headers: { authorization: `Bearer ${rawKey}` },
      method: "POST",
      ip,
    };
    const context = {
      getHandler: () => undefined,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(RateLimitExceededException);
    expect([...redis.values.keys()].join(" ")).not.toContain(rawKey);
    expect([...redis.values.keys()].join(" ")).not.toContain(ip);
  });

  it("fails closed when an application member lacks the persisted endpoint permission", async () => {
    const guard = new ApiKeyScopeGuard(
      { get: vi.fn().mockReturnValue("model:write") } as unknown as Reflector,
      {
        application: {
          findFirst: vi.fn().mockResolvedValue({
            id: "00000000-0000-4000-8000-000000000001",
            slug: "support",
            members: [{ role: "ADMIN", permissions: ["model:read"] }],
          }),
        },
      } as unknown as DatabaseClient,
      new FakeRedis() as unknown as Redis,
      configuration,
      {
        authenticate: vi.fn().mockResolvedValue({ sessionId: "session-1", userId: "user-1" }),
      } as unknown as WebAuthService,
    );
    const context = {
      getHandler: () => undefined,
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {},
          method: "GET",
          params: { applicationSlug: "support" },
        }),
      }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("intersects a stored permission with the member role before allowing it", async () => {
    const database = {
      application: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({
            id: "00000000-0000-4000-8000-000000000001",
            slug: "support",
            members: [{ role: "VIEWER", permissions: ["admin:write"] }],
          })
          .mockResolvedValueOnce({
            id: "00000000-0000-4000-8000-000000000001",
            slug: "support",
            members: [{ role: "ADMIN", permissions: ["admin:write"] }],
          }),
      },
    } as unknown as DatabaseClient;
    const guard = new ApiKeyScopeGuard(
      { get: vi.fn().mockReturnValue("admin:write") } as unknown as Reflector,
      database,
      new FakeRedis() as unknown as Redis,
      configuration,
      {
        authenticate: vi.fn().mockResolvedValue({ sessionId: "session-1", userId: "user-1" }),
      } as unknown as WebAuthService,
    );
    const context = {
      getHandler: () => undefined,
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {},
          method: "GET",
          params: { applicationSlug: "support" },
        }),
      }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("lets a paused application fetch and acknowledge its stop policy but denies model calls", async () => {
    const rawKey = "tp_paused_runtime_key_00000000000000000000000000000000";
    const keyHash = hashApplicationApiKey(rawKey, configuration.apiKeyPepper);
    const database = {
      applicationApiKey: {
        findUnique: vi.fn().mockResolvedValue({
          id: "00000000-0000-4000-8000-000000000099",
          applicationId: "00000000-0000-4000-8000-000000000001",
          keyHash,
          scopes: ["runtime:read", "runtime:write", "runtime:ack"],
          status: "ACTIVE",
          expiresAt: null,
          application: { slug: "support", status: "DISABLED" },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    } as unknown as DatabaseClient;
    const contextFor = (scope: string) =>
      ({
        getHandler: () => undefined,
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { authorization: `Bearer ${rawKey}` },
            method: scope === "runtime:read" ? "GET" : "POST",
            params: {},
            ip: "192.0.2.10",
          }),
        }),
      }) as unknown as ExecutionContext;
    const guardFor = (scope: string) =>
      new ApiKeyScopeGuard(
        { get: vi.fn().mockReturnValue(scope) } as unknown as Reflector,
        database,
        new FakeRedis() as unknown as Redis,
        configuration,
        { authenticate: vi.fn().mockResolvedValue(null) } as unknown as WebAuthService,
      );

    await expect(guardFor("runtime:read").canActivate(contextFor("runtime:read"))).resolves.toBe(
      true,
    );
    await expect(guardFor("runtime:ack").canActivate(contextFor("runtime:ack"))).resolves.toBe(
      true,
    );
    await expect(
      guardFor("runtime:write").canActivate(contextFor("runtime:write")),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

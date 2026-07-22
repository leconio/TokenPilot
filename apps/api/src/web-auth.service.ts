import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

import { ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import type { Redis } from "ioredis";

import type { DatabaseClient } from "@tokenpilot/db";

import type { ApiConfiguration } from "./api-config.js";
import { RateLimitExceededException } from "./rate-limit.js";
import { API_CONFIGURATION, DATABASE_CLIENT, REDIS_CLIENT } from "./tokens.js";
import { initializeWebSetup } from "./web-auth-setup.js";

const scrypt = promisify(scryptCallback);
const loginSchema = z.strictObject({
  email: z.string().email().max(320),
  password: z.string().min(1).max(256),
});

export interface WebSessionIdentity {
  readonly sessionId: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string;
}

export function cookies(header: string | undefined): Record<string, string> {
  if (header === undefined) return {};
  return Object.fromEntries(
    header.split(";").flatMap((part) => {
      const separator = part.indexOf("=");
      if (separator < 1) return [];
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      return [[key, decodeURIComponent(value)]];
    }),
  );
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltValue, hashValue] = encoded.split("$");
  if (algorithm !== "scrypt" || saltValue === undefined || hashValue === undefined) return false;
  const expected = Buffer.from(hashValue, "base64url");
  const actual = (await scrypt(
    password,
    Buffer.from(saltValue, "base64url"),
    expected.length,
  )) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

@Injectable()
export class WebAuthService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(API_CONFIGURATION) private readonly configuration: ApiConfiguration,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async setupStatus() {
    const [users, applications] = await Promise.all([
      this.database.user.count(),
      this.database.application.count(),
    ]);
    return {
      setup_required: users === 0 || applications === 0,
      defaults: {
        timezone: this.configuration.timezone,
        base_currency: this.configuration.baseCurrency,
      },
    };
  }

  async initialize(input: unknown, ipAddress?: string, userAgent?: string) {
    return initializeWebSetup(this.database, this.configuration, input, ipAddress, userAgent);
  }

  async login(input: unknown, ipAddress?: string, userAgent?: string) {
    const candidateEmail =
      input !== null &&
      typeof input === "object" &&
      typeof (input as { email?: unknown }).email === "string"
        ? (input as { email: string }).email.toLowerCase().slice(0, 320)
        : "(invalid)";
    const loginRateLimitKeys = await this.enforceLoginRateLimit(
      ipAddress ?? "unknown",
      candidateEmail,
    );
    const parsed = loginSchema.safeParse(input);
    if (!parsed.success) throw new UnauthorizedException("Invalid email or password");
    const email = parsed.data.email.toLowerCase();
    const account = await this.database.account.findUnique({
      where: { providerId_accountId: { providerId: "credential", accountId: email } },
      include: { user: true },
    });
    if (
      account?.password === null ||
      account?.password === undefined ||
      !(await verifyPassword(parsed.data.password, account.password))
    ) {
      throw new UnauthorizedException("Invalid email or password");
    }
    await this.redis.del(...loginRateLimitKeys);
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const session = await this.database.session.create({
      data: {
        id: randomUUID(),
        token: hashToken(token),
        userId: account.userId,
        expiresAt,
        ...(ipAddress === undefined ? {} : { ipAddress }),
        ...(userAgent === undefined ? {} : { userAgent: userAgent.slice(0, 500) }),
      },
    });
    return {
      identity: {
        sessionId: session.id,
        userId: account.user.id,
        name: account.user.name,
        email: account.user.email,
      },
      token,
      csrf,
      expiresAt,
    };
  }

  async authenticate(cookieHeader: string | undefined): Promise<WebSessionIdentity | null> {
    const token = cookies(cookieHeader).cp_session;
    if (token === undefined) return null;
    const session = await this.database.session.findUnique({
      where: { token: hashToken(token) },
      include: { user: true },
    });
    if (session === null || session.expiresAt <= new Date()) return null;
    return {
      sessionId: session.id,
      userId: session.user.id,
      name: session.user.name,
      email: session.user.email,
    };
  }

  async logout(cookieHeader: string | undefined): Promise<void> {
    const token = cookies(cookieHeader).cp_session;
    if (token !== undefined) {
      await this.database.session.deleteMany({ where: { token: hashToken(token) } });
    }
  }

  cookieHeaders(token: string, csrf: string, expiresAt: Date): string[] {
    const secure = this.cookieSecureSuffix();
    const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    return [
      `cp_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`,
      `cp_csrf=${encodeURIComponent(csrf)}; Path=/; SameSite=Strict; Max-Age=${maxAge}${secure}`,
    ];
  }

  clearCookieHeaders(): string[] {
    const secure = this.cookieSecureSuffix();
    return [
      `cp_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
      `cp_csrf=; Path=/; SameSite=Strict; Max-Age=0${secure}`,
    ];
  }

  private cookieSecureSuffix(): string {
    const secure =
      this.configuration.webSessionCookieSecure ?? this.configuration.environment === "production";
    return secure ? "; Secure" : "";
  }

  assertCsrf(
    cookieHeader: string | undefined,
    csrfHeader: unknown,
    origin?: string | string[],
    secFetchSite?: string | string[],
  ): void {
    const csrf = cookies(cookieHeader).cp_csrf;
    if (
      csrf === undefined ||
      typeof csrfHeader !== "string" ||
      csrfHeader.length < 16 ||
      csrf.length !== csrfHeader.length ||
      !timingSafeEqual(Buffer.from(csrf), Buffer.from(csrfHeader))
    ) {
      throw new ForbiddenException("A valid CSRF token is required");
    }
    this.assertSameOrigin(origin, secFetchSite, true);
  }

  assertPreAuthOrigin(origin?: string | string[], secFetchSite?: string | string[]): void {
    this.assertSameOrigin(origin, secFetchSite, false);
  }

  private assertSameOrigin(
    originValue: string | string[] | undefined,
    secFetchSiteValue: string | string[] | undefined,
    requireBrowserEvidence: boolean,
  ): void {
    const origin = Array.isArray(originValue) ? originValue[0] : originValue;
    const secFetchSite = Array.isArray(secFetchSiteValue)
      ? secFetchSiteValue[0]
      : secFetchSiteValue;
    if (secFetchSite === "cross-site") {
      throw new ForbiddenException("Cross-site browser requests are not allowed");
    }
    if (
      secFetchSite !== undefined &&
      !["same-origin", "same-site", "none"].includes(secFetchSite)
    ) {
      throw new ForbiddenException("The browser request site is not allowed");
    }
    if (origin !== undefined) {
      let requestOrigin: string;
      try {
        requestOrigin = new URL(origin).origin;
      } catch {
        throw new ForbiddenException("The request origin is not allowed");
      }
      if (requestOrigin !== new URL(this.configuration.webBaseUrl).origin) {
        throw new ForbiddenException("The request origin is not allowed");
      }
    }
    if (requireBrowserEvidence && origin === undefined && secFetchSite !== "same-origin") {
      throw new ForbiddenException("A same-origin browser request is required");
    }
  }

  private async enforceLoginRateLimit(
    ipAddress: string,
    email: string,
  ): Promise<readonly [string, string]> {
    const duration = this.configuration.loginRateLimitWindowSeconds;
    const window = Math.floor(Date.now() / (duration * 1000));
    const ipIdentity = createHmac("sha256", this.configuration.apiKeyPepper)
      .update(`login-ip\u0000${ipAddress}`)
      .digest("hex");
    const emailIdentity = createHmac("sha256", this.configuration.apiKeyPepper)
      .update(`login-email\u0000${email}`)
      .digest("hex");
    const keys = [
      `login-rate:ip:${ipIdentity}:${window}`,
      `login-rate:email:${emailIdentity}:${window}`,
    ] as const;
    const attempts = await Promise.all(keys.map((key) => this.redis.incr(key)));
    await Promise.all(
      keys.map(async (key, index) => {
        if (attempts[index] === 1) await this.redis.expire(key, duration + 1);
      }),
    );
    if (attempts.some((value) => value > this.configuration.loginRateLimitMax)) {
      const ttls = await Promise.all(keys.map((key) => this.redis.ttl(key)));
      const activeTtls = ttls.filter((ttl) => ttl > 0);
      const retryAfter = activeTtls.length === 0 ? duration : Math.max(...activeTtls);
      throw new RateLimitExceededException(retryAfter);
    }
    return keys;
  }
}

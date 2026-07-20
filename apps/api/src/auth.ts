import { createHmac } from "node:crypto";

import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import type { Redis } from "ioredis";

import {
  effectiveApplicationPermissions,
  verifyApplicationApiKey,
  type DatabaseClient,
} from "@tokenpilot/db";

import type { ApiConfiguration } from "./api-config.js";
import { AuditContextService } from "./audit-context.js";
import { RateLimitExceededException } from "./rate-limit.js";
import { API_CONFIGURATION, DATABASE_CLIENT, REDIS_CLIENT } from "./tokens.js";
import { WebAuthService } from "./web-auth.service.js";

const REQUIRED_SCOPE = "required-machine-scope";

export type MachineScope =
  | "usage:write"
  | "usage:read"
  | "connector:heartbeat"
  | "model:read"
  | "model:write"
  | "configuration:read"
  | "configuration:write"
  | "admin:read"
  | "admin:write"
  | "pricing:read"
  | "pricing:write"
  | "reports:read"
  | "jobs:read"
  | "jobs:write"
  | "runtime:read"
  | "runtime:write"
  | "runtime:ack"
  | "reconciliation:read"
  | "reconciliation:write";

export const API_SCOPES: readonly MachineScope[] = [
  "usage:write",
  "usage:read",
  "connector:heartbeat",
  "model:read",
  "model:write",
  "configuration:read",
  "configuration:write",
  "admin:read",
  "admin:write",
  "pricing:read",
  "pricing:write",
  "reports:read",
  "jobs:read",
  "jobs:write",
  "runtime:read",
  "runtime:write",
  "runtime:ack",
  "reconciliation:read",
  "reconciliation:write",
] as const;

const apiScopeSet = new Set<string>(API_SCOPES);

export function isApiScope(scope: string): scope is MachineScope {
  return apiScopeSet.has(scope);
}

export type ApiAccessPlane = "machine" | "admin" | "neutral";

const machineOnlyScopes = new Set<MachineScope>([
  "usage:write",
  "connector:heartbeat",
  "runtime:read",
  "runtime:write",
  "runtime:ack",
]);

const disabledApplicationScopes = new Set<MachineScope>(["runtime:read", "runtime:ack"]);

const adminOnlyScopes = new Set<MachineScope>([
  "usage:read",
  "model:read",
  "model:write",
  "configuration:read",
  "configuration:write",
  "admin:read",
  "admin:write",
  "pricing:read",
  "pricing:write",
  "reports:read",
  "jobs:read",
  "jobs:write",
  "reconciliation:read",
  "reconciliation:write",
]);

export function accessPlaneForScope(scope: string): ApiAccessPlane {
  if (machineOnlyScopes.has(scope as MachineScope)) return "machine";
  if (adminOnlyScopes.has(scope as MachineScope)) return "admin";
  return "neutral";
}

export function scopesUseSingleAccessPlane(scopes: readonly string[]): boolean {
  const planes = new Set(
    scopes
      .map(accessPlaneForScope)
      .filter((plane): plane is Exclude<ApiAccessPlane, "neutral"> => plane !== "neutral"),
  );
  return planes.size <= 1;
}

export const RequireMachineScope = (scope: MachineScope) => SetMetadata(REQUIRED_SCOPE, scope);

export const WEB_SESSION_SCOPES: readonly MachineScope[] = [
  "usage:read",
  "model:read",
  "model:write",
  "configuration:read",
  "configuration:write",
  "admin:read",
  "admin:write",
  "pricing:read",
  "pricing:write",
  "reports:read",
  "jobs:read",
  "jobs:write",
  "reconciliation:read",
  "reconciliation:write",
] as const;
const webSessionScopes = new Set<MachineScope>(WEB_SESSION_SCOPES);

@Injectable()
export class ApiKeyScopeGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(API_CONFIGURATION) private readonly configuration: ApiConfiguration,
    @Inject(WebAuthService) private readonly webAuth: WebAuthService,
    @Optional() @Inject(AuditContextService) private readonly auditContext?: AuditContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredScope = this.reflector.get<MachineScope>(REQUIRED_SCOPE, context.getHandler());
    if (requiredScope === undefined) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const authorization = request.headers.authorization;
    if (authorization === undefined || !authorization.startsWith("Bearer ")) {
      const identity = await this.webAuth.authenticate(request.headers.cookie);
      if (identity === null)
        throw new UnauthorizedException("A Bearer API key or web session is required");
      if (!webSessionScopes.has(requiredScope)) {
        throw new ForbiddenException(`A web session cannot use ${requiredScope}`);
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        this.webAuth.assertCsrf(
          request.headers.cookie,
          request.headers["x-csrf-token"],
          request.headers.origin,
          request.headers["sec-fetch-site"],
        );
      }
      await this.enforceRateLimit(`session:${identity.sessionId}`);
      this.auditContext?.setActor(`user:${identity.userId}`);
      const applicationSlug = this.applicationSlug(request);
      if (applicationSlug !== undefined) {
        const application = await this.database.application.findFirst({
          where: {
            slug: applicationSlug,
            status: "ACTIVE",
            members: { some: { userId: identity.userId } },
          },
          select: {
            id: true,
            slug: true,
            members: {
              where: { userId: identity.userId },
              select: { role: true, permissions: true },
              take: 1,
            },
          },
        });
        if (application === null) {
          throw new ForbiddenException("The application is not available to this user");
        }
        const member = application.members[0];
        const permissions =
          member === undefined
            ? []
            : effectiveApplicationPermissions(member.role, member.permissions, WEB_SESSION_SCOPES);
        if (!permissions.some((permission) => permission === requiredScope)) {
          throw new ForbiddenException("The application permission does not allow this action");
        }
        this.auditContext?.setApplication(application.id, application.slug);
      }
      return true;
    }
    const rawKey = authorization.slice("Bearer ".length);
    await this.assertInvalidBearerAllowed(request.ip);
    const credential = await verifyApplicationApiKey(
      this.database,
      rawKey,
      this.configuration.apiKeyPepper,
    );
    if (credential === null) {
      await this.recordInvalidBearer(request.ip);
      throw new UnauthorizedException("The API key is invalid or expired");
    }
    if (!credential.scopes.includes(requiredScope)) {
      throw new ForbiddenException(`The API key lacks ${requiredScope}`);
    }
    if (
      credential.applicationStatus !== "ACTIVE" &&
      !disabledApplicationScopes.has(requiredScope)
    ) {
      throw new ForbiddenException("The application is paused");
    }
    const requiredPlane = accessPlaneForScope(requiredScope);
    if (requiredPlane !== "neutral" && !scopesUseSingleAccessPlane(credential.scopes)) {
      throw new ForbiddenException(
        `${requiredPlane} endpoints require a key that is not shared with another access plane`,
      );
    }

    const requestedApplication = this.applicationSlug(request);
    if (requestedApplication !== undefined && requestedApplication !== credential.applicationSlug) {
      throw new ForbiddenException("The API key belongs to another application");
    }
    await this.enforceRateLimit(`app:${credential.applicationId}:key:${credential.id}`);
    this.auditContext?.setActor(`service_key:${credential.id}`);
    this.auditContext?.setApplication(credential.applicationId, credential.applicationSlug);
    return true;
  }

  private applicationSlug(request: FastifyRequest): string | undefined {
    const value = (request.params as { applicationSlug?: unknown } | undefined)?.applicationSlug;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private async enforceRateLimit(identity: string): Promise<void> {
    const window = Math.floor(Date.now() / 60_000);
    const rateKey = `api-rate:${identity}:${window}`;
    const count = await this.redis.incr(rateKey);
    if (count === 1) await this.redis.expire(rateKey, 61);
    if (count > this.configuration.rateLimitMax) {
      throw new RateLimitExceededException(await this.retryAfter(rateKey, 60));
    }
  }

  private invalidBearerKey(ipAddress: string): string {
    const duration = this.configuration.loginRateLimitWindowSeconds;
    const window = Math.floor(Date.now() / (duration * 1000));
    const identity = createHmac("sha256", this.configuration.apiKeyPepper)
      .update(`invalid-bearer\u0000${ipAddress}`)
      .digest("hex");
    return `invalid-bearer-rate:${identity}:${window}`;
  }

  private async assertInvalidBearerAllowed(ipAddress: string): Promise<void> {
    const key = this.invalidBearerKey(ipAddress);
    const attempts = Number((await this.redis.get(key)) ?? "0");
    if (attempts >= this.configuration.loginRateLimitMax) {
      throw new RateLimitExceededException(
        await this.retryAfter(key, this.configuration.loginRateLimitWindowSeconds),
      );
    }
  }

  private async recordInvalidBearer(ipAddress: string): Promise<void> {
    const duration = this.configuration.loginRateLimitWindowSeconds;
    const key = this.invalidBearerKey(ipAddress);
    const attempts = await this.redis.incr(key);
    if (attempts === 1) await this.redis.expire(key, duration + 1);
    if (attempts > this.configuration.loginRateLimitMax) {
      throw new RateLimitExceededException(await this.retryAfter(key, duration));
    }
  }

  private async retryAfter(key: string, fallback: number): Promise<number> {
    const ttl = await this.redis.ttl(key);
    return ttl > 0 ? Math.min(ttl, fallback) : fallback;
  }
}

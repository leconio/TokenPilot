import type { BetterAuthOptions } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";

import type { DatabaseClient } from "./client.js";

export interface AuthRuntimeConfiguration {
  readonly baseURL: string;
  readonly secret: string;
  readonly trustedOrigins?: readonly string[];
}

export const authSecurityDefaults = {
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    revokeSessionsOnPasswordReset: true,
  },
  rateLimit: {
    enabled: true,
    storage: "database",
    modelName: "rateLimit",
    window: 60,
    max: 10,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
} as const;

export function createAuthOptions(
  database: DatabaseClient,
  configuration: AuthRuntimeConfiguration,
): BetterAuthOptions {
  if (Buffer.byteLength(configuration.secret, "utf8") < 32) {
    throw new Error("Better Auth secret must contain at least 32 bytes");
  }
  const baseURL = new URL(configuration.baseURL).toString();
  return {
    database: prismaAdapter(database, { provider: "postgresql" }),
    baseURL,
    trustedOrigins:
      configuration.trustedOrigins === undefined ? [] : [...configuration.trustedOrigins],
    secret: configuration.secret,
    ...authSecurityDefaults,
  };
}

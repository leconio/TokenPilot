import {
  featureFlagsFromEnvironment,
  featureRuntimePrerequisitesFromEnvironment,
  type Environment,
  type InstanceFeatureFlags,
  type InstanceFeatureRuntimePrerequisites,
} from "@tokenpilot/shared";

export interface ApiConfiguration {
  readonly instanceId: string;
  readonly environment: "development" | "test" | "staging" | "production";
  readonly timezone: string;
  readonly baseCurrency: string;
  readonly featureFlagDefaults?: InstanceFeatureFlags;
  readonly featureRuntimePrerequisites?: InstanceFeatureRuntimePrerequisites;
  readonly aiuMicroScale?: number;
  readonly aiuReservationSigningKey?: string;
  readonly aiuReservationKeyVersion?: string;
  readonly aiuReservationTtlSeconds?: number;
  readonly webBaseUrl: string;
  readonly webSessionCookieSecure?: boolean;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly clickhouseDatabase: string;
  readonly apiKeyPepper: string;
  readonly port: number;
  readonly logLevel: Environment["LOG_LEVEL"];
  readonly maxBatchSize: number;
  readonly maxCompressedBytes: number;
  readonly maxDecompressedBytes: number;
  readonly requestTimeoutMs: number;
  readonly rateLimitMax: number;
  readonly loginRateLimitMax: number;
  readonly loginRateLimitWindowSeconds: number;
  readonly connectorStaleAfterSeconds: number;
  readonly connectorBacklogAlertDepth: number;
}

export function shouldSendStrictTransportSecurity(configuration: ApiConfiguration): boolean {
  return (
    configuration.environment === "production" &&
    new URL(configuration.webBaseUrl).protocol === "https:"
  );
}

export function toApiConfiguration(environment: Environment): ApiConfiguration {
  return {
    instanceId: environment.INSTANCE_ID,
    environment: environment.ENVIRONMENT,
    timezone: environment.APP_TIMEZONE,
    baseCurrency: environment.BASE_CURRENCY,
    featureFlagDefaults: featureFlagsFromEnvironment(environment),
    featureRuntimePrerequisites: featureRuntimePrerequisitesFromEnvironment(environment),
    aiuMicroScale: environment.AIU_MICRO_SCALE,
    ...(environment.AIU_RESERVATION_SIGNING_KEY === undefined
      ? {}
      : { aiuReservationSigningKey: environment.AIU_RESERVATION_SIGNING_KEY }),
    aiuReservationKeyVersion: environment.AIU_RESERVATION_KEY_VERSION,
    aiuReservationTtlSeconds: environment.AIU_RESERVATION_TTL_SECONDS,
    webBaseUrl: environment.WEB_BASE_URL,
    webSessionCookieSecure:
      environment.WEB_SESSION_COOKIE_SECURE ?? environment.ENVIRONMENT === "production",
    databaseUrl: environment.DATABASE_URL,
    redisUrl: environment.REDIS_URL,
    clickhouseDatabase: environment.CLICKHOUSE_DATABASE,
    apiKeyPepper: environment.API_KEY_PEPPER,
    port: environment.API_PORT,
    logLevel: environment.LOG_LEVEL,
    maxBatchSize: environment.INGEST_MAX_BATCH_SIZE,
    maxCompressedBytes: environment.INGEST_MAX_COMPRESSED_BYTES,
    maxDecompressedBytes: environment.INGEST_MAX_DECOMPRESSED_BYTES,
    requestTimeoutMs: environment.API_REQUEST_TIMEOUT_MS,
    rateLimitMax: environment.API_RATE_LIMIT_MAX,
    loginRateLimitMax: environment.LOGIN_RATE_LIMIT_MAX,
    loginRateLimitWindowSeconds: environment.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
    connectorStaleAfterSeconds: environment.CONNECTOR_STALE_AFTER_SECONDS,
    connectorBacklogAlertDepth: environment.CONNECTOR_BACKLOG_ALERT_DEPTH,
  };
}

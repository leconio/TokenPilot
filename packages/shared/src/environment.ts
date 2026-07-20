import { z } from "zod";

import {
  currentRuntimeEnvironmentShape,
  refineCurrentRuntimeEnvironment,
  type CurrentRuntimeEnvironment,
} from "./runtime-environment.js";

const booleanEnvironmentValueSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");
const optionalBooleanEnvironmentValueSchema = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");
const databaseUrlEnvironmentValueSchema = z.string().url().startsWith("postgresql://");
const redisUrlEnvironmentValueSchema = z.string().url().startsWith("redis://");
const baseCurrencyEnvironmentValueSchema = z.string().regex(/^[A-Z]{3}$/);
const rawEventRetentionDaysEnvironmentValueSchema = z.coerce.number().int().positive().max(3650);
const connectorStaleAfterSecondsEnvironmentValueSchema = z.coerce
  .number()
  .int()
  .positive()
  .default(120);

const featureFlagDefaultsEnvironmentShape = {
  FEATURE_USAGE_PIPELINE: optionalBooleanEnvironmentValueSchema,
  FEATURE_MODEL_CATALOG: optionalBooleanEnvironmentValueSchema,
  FEATURE_AIU: optionalBooleanEnvironmentValueSchema,
  FEATURE_QUOTA: optionalBooleanEnvironmentValueSchema,
  FEATURE_HARD_LIMIT: optionalBooleanEnvironmentValueSchema,
  FEATURE_RECONCILIATION: optionalBooleanEnvironmentValueSchema,
} as const;

type FeatureFlagDefaultsEnvironment = {
  [Key in keyof typeof featureFlagDefaultsEnvironmentShape]: z.output<
    (typeof featureFlagDefaultsEnvironmentShape)[Key]
  >;
};
type ApiCurrentEnvironment = FeatureFlagDefaultsEnvironment & CurrentRuntimeEnvironment;

function refineFeatureFlagDefaultsEnvironment(
  value: ApiCurrentEnvironment,
  context: z.RefinementCtx,
): void {
  const issue = (path: keyof FeatureFlagDefaultsEnvironment, message: string) =>
    context.addIssue({ code: "custom", path: [path], message });

  if (value.FEATURE_AIU && !value.AIU_ENABLED) {
    issue("FEATURE_AIU", "FEATURE_AIU requires AIU_ENABLED=true");
  }
  if (value.FEATURE_QUOTA && !value.FEATURE_AIU) {
    issue("FEATURE_QUOTA", "FEATURE_QUOTA requires FEATURE_AIU=true");
  }
  if (value.FEATURE_HARD_LIMIT && (!value.FEATURE_QUOTA || value.AIU_MODE !== "hard_limit")) {
    issue(
      "FEATURE_HARD_LIMIT",
      "FEATURE_HARD_LIMIT requires FEATURE_QUOTA=true and AIU_MODE=hard_limit",
    );
  }
  if (
    value.FEATURE_RECONCILIATION &&
    !value.RECONCILIATION_HOURLY_ENABLED &&
    !value.RECONCILIATION_DAILY_ENABLED
  ) {
    issue(
      "FEATURE_RECONCILIATION",
      "FEATURE_RECONCILIATION requires at least one reconciliation schedule",
    );
  }
}

const environmentObjectSchema = z.strictObject({
  INSTANCE_ID: z.string().min(1).max(256),
  ENVIRONMENT: z.enum(["development", "test", "staging", "production"]),
  APP_TIMEZONE: z.string().min(1).max(128),
  BASE_CURRENCY: baseCurrencyEnvironmentValueSchema,
  DATABASE_URL: databaseUrlEnvironmentValueSchema,
  REDIS_URL: redisUrlEnvironmentValueSchema,
  WEB_BASE_URL: z.string().url(),
  API_BASE_URL: z.string().url(),
  WEB_SESSION_COOKIE_SECURE: booleanEnvironmentValueSchema.optional(),
  STORE_PROMPT_CONTENT: booleanEnvironmentValueSchema,
  STORE_RESPONSE_CONTENT: booleanEnvironmentValueSchema,
  RAW_EVENT_RETENTION_DAYS: rawEventRetentionDaysEnvironmentValueSchema,
  API_PORT: z.coerce.number().int().positive().max(65535).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  API_KEY_PEPPER: z.string().min(32),
  INGEST_MAX_BATCH_SIZE: z.coerce.number().int().positive().max(5000).default(500),
  INGEST_MAX_COMPRESSED_BYTES: z.coerce.number().int().positive().default(1_048_576),
  INGEST_MAX_DECOMPRESSED_BYTES: z.coerce.number().int().positive().default(5_242_880),
  API_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(10_000),
  API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  CONNECTOR_STALE_AFTER_SECONDS: connectorStaleAfterSecondsEnvironmentValueSchema,
  CONNECTOR_BACKLOG_ALERT_DEPTH: z.coerce.number().int().nonnegative().default(1000),
  ...featureFlagDefaultsEnvironmentShape,
  ...currentRuntimeEnvironmentShape,
});

const workerEnvironmentObjectSchema = z.strictObject({
  INSTANCE_ID: z.string().min(1).max(256),
  ENVIRONMENT: z.enum(["development", "test", "staging", "production"]),
  DATABASE_URL: databaseUrlEnvironmentValueSchema,
  REDIS_URL: redisUrlEnvironmentValueSchema,
  BASE_CURRENCY: baseCurrencyEnvironmentValueSchema,
  CONNECTOR_STALE_AFTER_SECONDS: connectorStaleAfterSecondsEnvironmentValueSchema,
  EXPORT_DIRECTORY: z.string().min(1).max(4096).default(".tokenpilot/exports"),
  WORKER_METRICS_HOST: z.string().min(1).max(253).default("0.0.0.0"),
  WORKER_METRICS_PORT: z.coerce.number().int().positive().max(65_535).default(9464),
  PIPELINE_POLL_INTERVAL_MS: z.coerce.number().int().min(10).max(60_000).default(250),
  CLICKHOUSE_OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).max(60_000).default(500),
  INBOX_PAYLOAD_CLEANUP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(86_400_000)
    .default(300_000),
  INBOX_PAYLOAD_CLEANUP_BATCH_SIZE: z.coerce.number().int().min(1).max(5_000).default(500),
  AIU_RESERVATION_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(30_000),
  AIU_RESERVATION_SWEEP_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
  ...currentRuntimeEnvironmentShape,
});

const featureFlagOperatorEnvironmentObjectSchema = z.strictObject({
  DATABASE_URL: databaseUrlEnvironmentValueSchema,
  ...currentRuntimeEnvironmentShape,
});

const schedulerEnvironmentObjectSchema = z.strictObject({
  REDIS_URL: redisUrlEnvironmentValueSchema,
});

const databaseEnvironmentObjectSchema = z.strictObject({
  DATABASE_URL: databaseUrlEnvironmentValueSchema,
});

export const environmentSchema = environmentObjectSchema.superRefine((value, context) => {
  refineCurrentRuntimeEnvironment(value, context);
  refineFeatureFlagDefaultsEnvironment(value, context);
});

export const requiredEnvironmentKeys = Object.keys(environmentObjectSchema.shape) as Array<
  keyof typeof environmentObjectSchema.shape
>;

export const workerEnvironmentSchema = workerEnvironmentObjectSchema.superRefine(
  refineCurrentRuntimeEnvironment,
);
export const workerEnvironmentKeys = Object.keys(workerEnvironmentObjectSchema.shape) as Array<
  keyof typeof workerEnvironmentObjectSchema.shape
>;
export const featureFlagOperatorEnvironmentSchema =
  featureFlagOperatorEnvironmentObjectSchema.superRefine(refineCurrentRuntimeEnvironment);
export const featureFlagOperatorEnvironmentKeys = Object.keys(
  featureFlagOperatorEnvironmentObjectSchema.shape,
) as Array<keyof typeof featureFlagOperatorEnvironmentObjectSchema.shape>;
export const schedulerEnvironmentSchema = schedulerEnvironmentObjectSchema;
export const schedulerEnvironmentKeys = Object.keys(
  schedulerEnvironmentObjectSchema.shape,
) as Array<keyof typeof schedulerEnvironmentObjectSchema.shape>;
export const databaseEnvironmentSchema = databaseEnvironmentObjectSchema;
export const databaseEnvironmentKeys = Object.keys(databaseEnvironmentObjectSchema.shape) as Array<
  keyof typeof databaseEnvironmentObjectSchema.shape
>;

export type Environment = z.output<typeof environmentSchema>;
export type WorkerEnvironment = z.output<typeof workerEnvironmentSchema>;
export type FeatureFlagOperatorEnvironment = z.output<typeof featureFlagOperatorEnvironmentSchema>;
export type SchedulerEnvironment = z.output<typeof schedulerEnvironmentSchema>;
export type DatabaseEnvironment = z.output<typeof databaseEnvironmentSchema>;

function selectEnvironmentKeys(
  input: Record<string, string | undefined>,
  keys: readonly string[],
): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, input[key]]));
}

export function loadEnvironment(input: Record<string, string | undefined>): Environment {
  return environmentSchema.parse(selectEnvironmentKeys(input, requiredEnvironmentKeys));
}

export function loadWorkerEnvironment(
  input: Record<string, string | undefined>,
): WorkerEnvironment {
  return workerEnvironmentSchema.parse(selectEnvironmentKeys(input, workerEnvironmentKeys));
}

export function loadFeatureFlagOperatorEnvironment(
  input: Record<string, string | undefined>,
): FeatureFlagOperatorEnvironment {
  return featureFlagOperatorEnvironmentSchema.parse(
    selectEnvironmentKeys(input, featureFlagOperatorEnvironmentKeys),
  );
}

export function loadSchedulerEnvironment(
  input: Record<string, string | undefined>,
): SchedulerEnvironment {
  return schedulerEnvironmentSchema.parse(selectEnvironmentKeys(input, schedulerEnvironmentKeys));
}

export function loadDatabaseEnvironment(
  input: Record<string, string | undefined>,
): DatabaseEnvironment {
  return databaseEnvironmentSchema.parse(selectEnvironmentKeys(input, databaseEnvironmentKeys));
}

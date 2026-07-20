import { z } from "zod";

const optionalBooleanEnvironmentValueSchema = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");
const enabledByDefaultBooleanEnvironmentValueSchema = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");
const keyVersionEnvironmentValueSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/u);
const optionalSecretEnvironmentValueSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(32).optional(),
);

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

const clickHouseUrlEnvironmentValueSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      const url = parseUrl(value);
      return url !== undefined && ["http:", "https:"].includes(url.protocol);
    },
    { message: "CLICKHOUSE_URL must use http or https" },
  )
  .refine(
    (value) => {
      const url = parseUrl(value);
      return url !== undefined && url.username === "" && url.password === "";
    },
    { message: "CLICKHOUSE_URL must not embed credentials" },
  )
  .refine(
    (value) => {
      const url = parseUrl(value);
      return url !== undefined && url.search === "" && url.hash === "";
    },
    { message: "CLICKHOUSE_URL must not contain query parameters or a fragment" },
  )
  .default("http://clickhouse:8123");
const clickHouseIdentifierEnvironmentValueSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
  .max(128);
const clickHouseDatabaseEnvironmentValueSchema = clickHouseIdentifierEnvironmentValueSchema.refine(
  (value) => !["default", "system", "information_schema"].includes(value.toLowerCase()),
  { message: "CLICKHOUSE_DATABASE must not use a reserved database name" },
);
const clickHouseUsernameEnvironmentValueSchema = clickHouseIdentifierEnvironmentValueSchema.refine(
  (value) => value !== "default",
  { message: "CLICKHOUSE_USERNAME must use a least-privilege account" },
);
const clickHousePasswordEnvironmentValueSchema = z
  .string()
  .regex(/^[A-Za-z0-9._~!@#%^+=:-]{16,256}$/u, {
    message: "ClickHouse passwords must be 16-256 URL-safe characters",
  });
const aiuMicroScaleEnvironmentValueSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER)
  .default(1_000_000);
const nonnegativeDecimalEnvironmentValueSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u)
  .max(120);

export const currentRuntimeEnvironmentShape = {
  CLICKHOUSE_URL: clickHouseUrlEnvironmentValueSchema,
  CLICKHOUSE_DATABASE: clickHouseDatabaseEnvironmentValueSchema.default("ai_control_plane"),
  CLICKHOUSE_USERNAME: clickHouseUsernameEnvironmentValueSchema.default("ai_control_app"),
  CLICKHOUSE_PASSWORD: clickHousePasswordEnvironmentValueSchema,
  CLICKHOUSE_SECURE: optionalBooleanEnvironmentValueSchema,
  CLICKHOUSE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  CLICKHOUSE_INSERT_BATCH_SIZE: z.coerce.number().int().min(1).max(100_000).default(1000),
  CLICKHOUSE_INSERT_FLUSH_MS: z.coerce.number().int().min(10).max(60_000).default(1000),
  CLICKHOUSE_ASYNC_INSERT: enabledByDefaultBooleanEnvironmentValueSchema,
  CLICKHOUSE_WAIT_FOR_ASYNC_INSERT: enabledByDefaultBooleanEnvironmentValueSchema,
  CLICKHOUSE_RAW_RETENTION_DAYS: z.coerce.number().int().min(1).max(36_500).default(90),
  CLICKHOUSE_LINES_RETENTION_DAYS: z.coerce.number().int().min(1).max(36_500).default(180),
  CLICKHOUSE_MINUTE_RETENTION_DAYS: z.coerce.number().int().min(1).max(36_500).default(90),
  CLICKHOUSE_HOURLY_RETENTION_DAYS: z.coerce.number().int().min(1).max(36_500).default(730),
  CLICKHOUSE_DAILY_RETENTION_DAYS: z.coerce.number().int().min(1).max(36_500).default(1825),

  AIU_ENABLED: optionalBooleanEnvironmentValueSchema,
  AIU_MODE: z.enum(["disabled", "observe", "soft_limit", "hard_limit"]).default("disabled"),
  AIU_SYMBOL: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,15}$/u)
    .default("AIU"),
  AIU_MICRO_SCALE: aiuMicroScaleEnvironmentValueSchema,
  AIU_UNRATED_MODEL_POLICY: z
    .enum(["allow_unrated", "block_unrated", "fallback_required", "alert_only"])
    .default("allow_unrated"),
  AIU_ATTEMPT_CHARGE_POLICY: z
    .enum(["final_success_only", "all_successful_operations"])
    .default("final_success_only"),
  AIU_DEFAULT_ROUNDING: z.enum(["half_up", "ceil", "floor"]).default("half_up"),
  AIU_RESERVATION_SIGNING_KEY: optionalSecretEnvironmentValueSchema,
  AIU_RESERVATION_KEY_VERSION: keyVersionEnvironmentValueSchema.default("current"),
  AIU_RESERVATION_TTL_SECONDS: z.coerce.number().int().min(1).max(86_400).default(300),

  DIMENSION_MAX_KEYS: z.coerce.number().int().min(1).max(256).default(32),
  DIMENSION_MAX_KEY_LENGTH: z.coerce.number().int().min(1).max(256).default(64),
  DIMENSION_MAX_VALUE_LENGTH: z.coerce.number().int().min(1).max(4096).default(256),
  DIMENSION_MAX_TOTAL_BYTES: z.coerce.number().int().min(1).max(1_048_576).default(8192),
  DIMENSION_UNKNOWN_KEY_POLICY: z.literal("drop_and_record").default("drop_and_record"),

  INBOX_PAYLOAD_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(14),
  CH_SINK_MAX_RETRIES: z.coerce.number().int().min(0).max(1000).default(20),
  RECONCILIATION_HOURLY_ENABLED: enabledByDefaultBooleanEnvironmentValueSchema,
  RECONCILIATION_DAILY_ENABLED: enabledByDefaultBooleanEnvironmentValueSchema,
  RECONCILIATION_USER_HMAC_SECRET: optionalSecretEnvironmentValueSchema,
  RECON_COST_TOLERANCE: nonnegativeDecimalEnvironmentValueSchema.default("0.000001"),
  RECON_AIU_MICRO_TOLERANCE: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
} as const;

export const currentRuntimeEnvironmentSchema = z.strictObject(currentRuntimeEnvironmentShape);

export type CurrentRuntimeEnvironment = z.output<typeof currentRuntimeEnvironmentSchema>;

export function refineCurrentRuntimeEnvironment(
  value: CurrentRuntimeEnvironment,
  context: z.RefinementCtx,
): void {
  const issue = (path: keyof CurrentRuntimeEnvironment, message: string) =>
    context.addIssue({ code: "custom", path: [path], message });

  const clickHouseUrl = parseUrl(value.CLICKHOUSE_URL);
  if (
    clickHouseUrl !== undefined &&
    value.CLICKHOUSE_SECURE !== (clickHouseUrl.protocol === "https:")
  ) {
    issue("CLICKHOUSE_SECURE", "CLICKHOUSE_SECURE must match the CLICKHOUSE_URL protocol");
  }
  if (value.CLICKHOUSE_WAIT_FOR_ASYNC_INSERT && !value.CLICKHOUSE_ASYNC_INSERT) {
    issue(
      "CLICKHOUSE_WAIT_FOR_ASYNC_INSERT",
      "CLICKHOUSE_WAIT_FOR_ASYNC_INSERT requires CLICKHOUSE_ASYNC_INSERT=true",
    );
  }
  if (value.AIU_ENABLED && value.AIU_MODE === "disabled") {
    issue("AIU_MODE", "AIU_ENABLED=true requires an active AIU_MODE");
  }
  if (!value.AIU_ENABLED && value.AIU_MODE !== "disabled") {
    issue("AIU_MODE", "AIU_ENABLED=false requires AIU_MODE=disabled");
  }
  if (value.AIU_MODE === "hard_limit" && value.AIU_RESERVATION_SIGNING_KEY === undefined) {
    issue(
      "AIU_RESERVATION_SIGNING_KEY",
      "AIU_RESERVATION_SIGNING_KEY is required in hard-limit mode",
    );
  }
  if (
    value.DIMENSION_MAX_TOTAL_BYTES <
    value.DIMENSION_MAX_KEY_LENGTH + value.DIMENSION_MAX_VALUE_LENGTH
  ) {
    issue(
      "DIMENSION_MAX_TOTAL_BYTES",
      "DIMENSION_MAX_TOTAL_BYTES must fit at least one maximum key/value pair",
    );
  }
}

import { ClickHouseConfigurationError } from "./errors.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PASSWORD = /^[A-Za-z0-9._~!@#%^+=:-]{16,256}$/u;

export type ClickHouseCredentialRole = "application" | "migration";

export interface ClickHouseRuntimeConfig {
  readonly url: string;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly secure: boolean;
  readonly requestTimeoutMs: number;
  readonly maxOpenConnections: number;
  readonly insertBatchSize: number;
  readonly insertFlushMs: number;
  readonly asyncInsert: boolean;
  readonly waitForAsyncInsert: boolean;
  readonly safeRetryAttempts: number;
  readonly safeRetryBaseDelayMs: number;
}

export interface ClickHousePublicConfig {
  readonly url: string;
  readonly database: string;
  readonly username: string;
  readonly secure: boolean;
  readonly requestTimeoutMs: number;
  readonly maxOpenConnections: number;
  readonly insertBatchSize: number;
  readonly insertFlushMs: number;
  readonly asyncInsert: boolean;
  readonly waitForAsyncInsert: boolean;
  readonly safeRetryAttempts: number;
  readonly safeRetryBaseDelayMs: number;
}

export interface LoadClickHouseConfigOptions {
  readonly role?: ClickHouseCredentialRole;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new ClickHouseConfigurationError(`${name} must be true or false`);
}

function readPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  if (!/^\d+$/u.test(value)) {
    throw new ClickHouseConfigurationError(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new ClickHouseConfigurationError(`${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function readIdentifier(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name] ?? fallback;
  if (!IDENTIFIER.test(value)) {
    throw new ClickHouseConfigurationError(
      `${name} must be a ClickHouse identifier containing only letters, digits, and underscores`,
    );
  }
  return value;
}

function readDatabase(env: NodeJS.ProcessEnv): string {
  const value = readIdentifier(env, "CLICKHOUSE_DATABASE", "ai_control_plane");
  if (["default", "system", "information_schema"].includes(value.toLowerCase())) {
    throw new ClickHouseConfigurationError(
      "CLICKHOUSE_DATABASE must not use a reserved database name",
    );
  }
  return value;
}

function readUsername(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = readIdentifier(env, name, fallback);
  if (value === "default") {
    throw new ClickHouseConfigurationError(
      `${name} must use a least-privilege account instead of ClickHouse default`,
    );
  }
  return value;
}

function readUrl(env: NodeJS.ProcessEnv, secure: boolean): string {
  const raw = env.CLICKHOUSE_URL ?? "http://clickhouse:8123";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ClickHouseConfigurationError("CLICKHOUSE_URL must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ClickHouseConfigurationError("CLICKHOUSE_URL must use http or https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ClickHouseConfigurationError("CLICKHOUSE_URL must not embed credentials");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new ClickHouseConfigurationError(
      "CLICKHOUSE_URL must not contain query parameters or a fragment",
    );
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    throw new ClickHouseConfigurationError(
      "CLICKHOUSE_URL must not embed a database or proxy path; use CLICKHOUSE_DATABASE separately",
    );
  }
  if (secure !== (parsed.protocol === "https:")) {
    throw new ClickHouseConfigurationError(
      "CLICKHOUSE_SECURE must match the CLICKHOUSE_URL protocol",
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed.toString().replace(/\/$/u, "");
}

export function loadClickHouseConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadClickHouseConfigOptions = {},
): ClickHouseRuntimeConfig {
  const role = options.role ?? "application";
  const secure = readBoolean(env, "CLICKHOUSE_SECURE", false);
  const usernameName =
    role === "migration" ? "CLICKHOUSE_MIGRATION_USERNAME" : "CLICKHOUSE_USERNAME";
  const passwordName =
    role === "migration" ? "CLICKHOUSE_MIGRATION_PASSWORD" : "CLICKHOUSE_PASSWORD";
  const username = readUsername(
    env,
    usernameName,
    role === "migration" ? "ai_control_migrator" : "ai_control_app",
  );
  const password = env[passwordName] ?? "";
  if (password.length === 0) {
    throw new ClickHouseConfigurationError(`${passwordName} is required`);
  }
  if (password.length > 0 && !PASSWORD.test(password)) {
    throw new ClickHouseConfigurationError(`${passwordName} must be 16-256 URL-safe characters`);
  }
  const peerUsername =
    role === "migration"
      ? (env.CLICKHOUSE_USERNAME ?? "ai_control_app")
      : (env.CLICKHOUSE_MIGRATION_USERNAME ?? "ai_control_migrator");
  const peerPassword =
    role === "migration" ? env.CLICKHOUSE_PASSWORD : env.CLICKHOUSE_MIGRATION_PASSWORD;
  if (username === peerUsername || (password.length > 0 && password === peerPassword)) {
    throw new ClickHouseConfigurationError(
      "ClickHouse application and migration credentials must be distinct",
    );
  }

  const asyncInsert =
    role === "migration" ? false : readBoolean(env, "CLICKHOUSE_ASYNC_INSERT", true);
  const waitForAsyncInsert =
    role === "migration" ? true : readBoolean(env, "CLICKHOUSE_WAIT_FOR_ASYNC_INSERT", true);
  if (asyncInsert && !waitForAsyncInsert) {
    throw new ClickHouseConfigurationError(
      "CLICKHOUSE_WAIT_FOR_ASYNC_INSERT must be true when asynchronous inserts are enabled",
    );
  }

  return Object.freeze({
    url: readUrl(env, secure),
    database: readDatabase(env),
    username,
    password,
    secure,
    requestTimeoutMs: readPositiveInteger(env, "CLICKHOUSE_REQUEST_TIMEOUT_MS", 10_000, 300_000),
    maxOpenConnections: readPositiveInteger(env, "CLICKHOUSE_MAX_OPEN_CONNECTIONS", 10, 1_000),
    insertBatchSize: readPositiveInteger(env, "CLICKHOUSE_INSERT_BATCH_SIZE", 1_000, 100_000),
    insertFlushMs: readPositiveInteger(env, "CLICKHOUSE_INSERT_FLUSH_MS", 1_000, 60_000),
    asyncInsert,
    waitForAsyncInsert,
    safeRetryAttempts: readPositiveInteger(env, "CLICKHOUSE_SAFE_RETRY_ATTEMPTS", 3, 10),
    safeRetryBaseDelayMs: readPositiveInteger(
      env,
      "CLICKHOUSE_SAFE_RETRY_BASE_DELAY_MS",
      100,
      30_000,
    ),
  });
}

export function publicClickHouseConfig(config: ClickHouseRuntimeConfig): ClickHousePublicConfig {
  return {
    url: config.url,
    database: config.database,
    username: config.username,
    secure: config.secure,
    requestTimeoutMs: config.requestTimeoutMs,
    maxOpenConnections: config.maxOpenConnections,
    insertBatchSize: config.insertBatchSize,
    insertFlushMs: config.insertFlushMs,
    asyncInsert: config.asyncInsert,
    waitForAsyncInsert: config.waitForAsyncInsert,
    safeRetryAttempts: config.safeRetryAttempts,
    safeRetryBaseDelayMs: config.safeRetryBaseDelayMs,
  };
}

export function assertClickHouseIdentifier(value: string, label = "ClickHouse identifier"): string {
  if (!IDENTIFIER.test(value)) {
    throw new ClickHouseConfigurationError(`${label} is invalid`);
  }
  return value;
}

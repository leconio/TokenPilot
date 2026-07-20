const CREDENTIAL_IN_URL = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@[^\s/]+/giu;
const CREDENTIAL_ASSIGNMENT =
  /\b(password|passwd|authorization|access[_-]?token)\s*[:=]\s*[^\s,;]+/giu;

export class ClickHouseConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ClickHouseConfigurationError";
  }
}

export class ClickHouseMigrationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClickHouseMigrationError";
  }
}

export class ClickHouseMigrationLockError extends ClickHouseMigrationError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClickHouseMigrationLockError";
  }
}

export class ClickHouseSinkNotReadyError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClickHouseSinkNotReadyError";
  }
}

export function sanitizeClickHouseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(CREDENTIAL_IN_URL, "$1[redacted]@[redacted]")
    .replace(CREDENTIAL_ASSIGNMENT, "$1=[redacted]");
}

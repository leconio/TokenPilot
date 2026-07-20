type PlainRecord = Readonly<Record<string, unknown>>;

export interface RequiredDatastoreHealth {
  readonly postgres: string;
  readonly clickhouse: string;
  readonly redis: string;
  readonly ready: boolean;
}

function record(value: unknown): PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as PlainRecord)
    : {};
}

function status(value: unknown): string {
  if (typeof value === "string") return value.toLowerCase();
  const item = record(value);
  return typeof item.status === "string" ? item.status.toLowerCase() : "unknown";
}

function healthy(value: string): boolean {
  return value === "healthy" || value === "ready" || value === "ok";
}

export function requiredDatastoreHealth(payload: unknown): RequiredDatastoreHealth {
  const response = record(payload);
  const dependencies = record(response.dependencies);
  const postgres = status(dependencies.postgres);
  const clickhouse = status(dependencies.clickhouse);
  const redis = status(dependencies.redis);
  return {
    postgres,
    clickhouse,
    redis,
    ready:
      response.status === "ready" && healthy(postgres) && healthy(clickhouse) && healthy(redis),
  };
}

export const datastoreUnavailableMessage = "配置或统计服务暂时不可用，请稍后重试或联系管理员。";

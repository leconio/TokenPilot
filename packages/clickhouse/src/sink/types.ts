export const CLICKHOUSE_PIPELINE_EVENT_TYPES = [
  "usage_events_raw",
  "usage_lines",
  "provider_cost.provisional",
  "provider_cost.official_delta",
  "provider_cost.adjustment",
  "provider_cost.unpriced",
  "aiu.provisional",
  "aiu.official_delta",
  "aiu.decision",
  "application_user.profile",
] as const;

export type ClickHousePipelineEventType = (typeof CLICKHOUSE_PIPELINE_EVENT_TYPES)[number];

export interface ClickHouseOutboxRecord {
  readonly id: bigint;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly idempotencyKey: string;
  readonly replayOfOutboxId: bigint | null;
  readonly createdAt: Date;
}

export interface ClickHouseSinkIdentity {
  readonly environment: string;
  readonly instanceId?: string;
}

export const CLICKHOUSE_SINK_TABLES = [
  "usage_events_raw",
  "usage_lines",
  "rating_events",
  "application_user_profiles",
] as const;

export type ClickHouseSinkTable = (typeof CLICKHOUSE_SINK_TABLES)[number];

export type ClickHouseSinkRow = Readonly<Record<string, unknown>>;

export interface MappedClickHouseOutbox {
  readonly outboxId: bigint;
  readonly eventType: ClickHousePipelineEventType;
  readonly eventTime: Date | null;
  readonly rows: Readonly<Partial<Record<ClickHouseSinkTable, readonly ClickHouseSinkRow[]>>>;
}

export interface ClickHouseOutboxDeliveryResult {
  readonly outboxIds: readonly bigint[];
  readonly rowCount: number;
  readonly maxOutboxId: bigint;
  readonly maxEventTime: Date | null;
}

export type ClickHouseMetricOperation = "query" | "insert";

export interface ClickHouseOperationMetric {
  readonly operation: ClickHouseMetricOperation;
  readonly name: string;
  readonly queryId: string;
  readonly attempt: number;
  readonly rows: number;
  readonly bytes: number;
  readonly durationMs: number;
  readonly outcome: "success" | "failure";
  readonly errorClass?: string;
}

export interface ClickHouseMetricsSink {
  record(metric: ClickHouseOperationMetric): void | Promise<void>;
}

export const NOOP_CLICKHOUSE_METRICS: ClickHouseMetricsSink = Object.freeze({
  record: () => undefined,
});

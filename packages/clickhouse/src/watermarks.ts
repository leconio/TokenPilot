import type { ClickHouseOperations } from "./client/operations.js";

export type ClickHousePipelineStatus = "healthy" | "degraded" | "stale" | "failed";

export interface ClickHousePipelineWatermark {
  readonly pipelineName: string;
  readonly watermarkType: string;
  readonly cursor: string;
  readonly eventTime: string | null;
  readonly outboxId: string | null;
  readonly lagSeconds: number;
  readonly status: ClickHousePipelineStatus;
  readonly errorClass: string;
  readonly updatedAt: string;
  readonly version: string;
}

export interface WriteClickHousePipelineWatermark {
  readonly pipelineName: string;
  readonly watermarkType: string;
  readonly cursor: string;
  readonly eventTime?: Date;
  readonly outboxId?: bigint;
  readonly lagSeconds: number;
  readonly status: ClickHousePipelineStatus;
  readonly errorClass?: string;
  readonly updatedAt?: Date;
  readonly version: bigint;
}

interface WatermarkRow {
  readonly pipeline_name: string;
  readonly watermark_type: string;
  readonly cursor: string;
  readonly watermark_event_time: string | null;
  readonly watermark_outbox_id: string | null;
  readonly lag_seconds: number;
  readonly status: ClickHousePipelineStatus;
  readonly error_class: string;
  readonly updated_at: string;
  readonly version: string;
}

function dateTime(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

export async function writeClickHousePipelineWatermark(
  operations: ClickHouseOperations,
  input: WriteClickHousePipelineWatermark,
): Promise<void> {
  if (!Number.isSafeInteger(input.lagSeconds) || input.lagSeconds < 0) {
    throw new Error("ClickHouse watermark lag must be a non-negative safe integer");
  }
  if (input.version <= 0n || (input.outboxId !== undefined && input.outboxId < 0n)) {
    throw new Error("ClickHouse watermark versions must be positive and outbox IDs non-negative");
  }
  await operations.insertRows({
    name: "pipeline_watermark.write",
    table: "pipeline_watermarks",
    rows: [
      {
        pipeline_name: input.pipelineName,
        watermark_type: input.watermarkType,
        cursor: input.cursor,
        watermark_event_time: input.eventTime === undefined ? null : dateTime(input.eventTime),
        watermark_outbox_id: input.outboxId?.toString() ?? null,
        lag_seconds: input.lagSeconds,
        status: input.status,
        error_class: input.errorClass ?? "",
        updated_at: dateTime(input.updatedAt ?? new Date()),
        version: input.version.toString(),
      },
    ],
  });
}

export async function readClickHousePipelineWatermark(
  operations: ClickHouseOperations,
  pipelineName: string,
): Promise<ClickHousePipelineWatermark | null> {
  const result = await operations.queryRows<WatermarkRow, ClickHousePipelineWatermark>({
    name: "pipeline_watermark.read",
    query: `SELECT
      pipeline_name,
      tupleElement(latest, 1) AS watermark_type,
      tupleElement(latest, 2) AS cursor,
      tupleElement(latest, 3) AS watermark_event_time,
      toString(tupleElement(latest, 4)) AS watermark_outbox_id,
      tupleElement(latest, 5) AS lag_seconds,
      tupleElement(latest, 6) AS status,
      tupleElement(latest, 7) AS error_class,
      toString(tupleElement(latest, 8)) AS updated_at,
      toString(tupleElement(latest, 9)) AS version
    FROM (
      SELECT pipeline_name,
        argMax(
          tuple(
            watermark_type,
            cursor,
            watermark_event_time,
            watermark_outbox_id,
            lag_seconds,
            status,
            error_class,
            updated_at,
            version
          ),
          tuple(version, updated_at)
        ) AS latest
      FROM pipeline_watermarks
      WHERE pipeline_name = {pipelineName:String}
      GROUP BY pipeline_name
    )`,
    queryParams: { pipelineName },
    map: (row) => ({
      pipelineName: row.pipeline_name,
      watermarkType: row.watermark_type,
      cursor: row.cursor,
      eventTime: row.watermark_event_time,
      outboxId: row.watermark_outbox_id,
      lagSeconds: row.lag_seconds,
      status: row.status,
      errorClass: row.error_class,
      updatedAt: row.updated_at,
      version: row.version,
    }),
  });
  return result.rows[0] ?? null;
}

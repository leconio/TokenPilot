import type { ClickHouseOperations } from "../client/operations.js";
import { writeClickHousePipelineWatermark } from "../watermarks.js";
import { mapClickHouseOutbox } from "./mapper.js";
import {
  CLICKHOUSE_SINK_TABLES,
  type ClickHouseOutboxDeliveryResult,
  type ClickHouseOutboxRecord,
  type ClickHouseSinkIdentity,
  type ClickHouseSinkRow,
  type ClickHouseSinkTable,
} from "./types.js";

export interface ClickHouseOutboxBatchSinkOptions extends ClickHouseSinkIdentity {
  readonly pipelineName?: string;
  readonly now?: () => Date;
}

function uniqueSorted(
  records: readonly ClickHouseOutboxRecord[],
): readonly ClickHouseOutboxRecord[] {
  const byId = new Map<bigint, ClickHouseOutboxRecord>();
  for (const record of records) {
    const existing = byId.get(record.id);
    if (existing !== undefined && existing.idempotencyKey !== record.idempotencyKey) {
      throw new TypeError(`Conflicting outbox records share id ${record.id.toString()}`);
    }
    byId.set(record.id, record);
  }
  return [...byId.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

/**
 * Delivers a PG outbox batch and advances CH's watermark only after every async insert is acknowledged.
 * Stable source_outbox_id/sink_delivery_id values make replay duplicates detectable by reconciliation.
 */
export class ClickHouseOutboxBatchSink {
  private readonly pipelineName: string;
  private readonly now: () => Date;

  constructor(
    private readonly operations: ClickHouseOperations,
    private readonly options: ClickHouseOutboxBatchSinkOptions,
  ) {
    this.pipelineName = options.pipelineName ?? "analytics_sink";
    this.now = options.now ?? (() => new Date());
    if (options.environment.trim().length === 0) {
      throw new TypeError("ClickHouse sink environment must not be empty");
    }
    if (options.instanceId !== undefined && options.instanceId.trim().length === 0) {
      throw new TypeError("ClickHouse sink instance ID must not be empty");
    }
  }

  async deliver(
    records: readonly ClickHouseOutboxRecord[],
  ): Promise<ClickHouseOutboxDeliveryResult> {
    const batch = uniqueSorted(records);
    if (batch.length === 0)
      throw new RangeError("ClickHouse outbox delivery batch must not be empty");

    const grouped = new Map<ClickHouseSinkTable, ClickHouseSinkRow[]>(
      CLICKHOUSE_SINK_TABLES.map((table) => [table, []]),
    );
    let maxEventTime: Date | null = null;
    for (const record of batch) {
      const mapped = mapClickHouseOutbox(record, this.options);
      if (mapped.eventTime !== null && (maxEventTime === null || mapped.eventTime > maxEventTime)) {
        maxEventTime = mapped.eventTime;
      }
      for (const table of CLICKHOUSE_SINK_TABLES) {
        grouped.get(table)!.push(...(mapped.rows[table] ?? []));
      }
    }

    let rowCount = 0;
    for (const table of CLICKHOUSE_SINK_TABLES) {
      const rows = grouped.get(table)!;
      if (rows.length === 0) continue;
      const missingRows = await this.missingRows(table, rows);
      if (missingRows.length === 0) continue;
      await this.operations.insertRows({
        name: `outbox.${table}.insert`,
        table,
        rows: missingRows,
      });
      rowCount += missingRows.length;
    }

    const maxOutboxId = batch.at(-1)!.id;
    const now = this.now();
    const lagSeconds = Math.max(
      0,
      Math.floor((now.getTime() - (maxEventTime ?? batch.at(-1)!.createdAt).getTime()) / 1_000),
    );
    await writeClickHousePipelineWatermark(this.operations, {
      pipelineName: this.pipelineName,
      watermarkType: "outbox_id",
      cursor: maxOutboxId.toString(),
      ...(maxEventTime === null ? {} : { eventTime: maxEventTime }),
      outboxId: maxOutboxId,
      lagSeconds,
      status: "healthy",
      updatedAt: now,
      version: maxOutboxId,
    });

    return {
      outboxIds: batch.map((record) => record.id),
      rowCount,
      maxOutboxId,
      maxEventTime,
    };
  }

  private async missingRows(
    table: ClickHouseSinkTable,
    rows: readonly ClickHouseSinkRow[],
  ): Promise<readonly ClickHouseSinkRow[]> {
    const byDeliveryId = new Map<string, ClickHouseSinkRow>();
    for (const row of rows) {
      const id = row.sink_delivery_id;
      if (typeof id !== "string" || id.length === 0) {
        throw new TypeError(`${table} sink row has no delivery identity`);
      }
      const existing = byDeliveryId.get(id);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(row)) {
        throw new TypeError(`${table} contains conflicting rows for delivery ${id}`);
      }
      byDeliveryId.set(id, row);
    }
    const delivered = await this.operations.queryRows<{ readonly sink_delivery_id: string }>({
      name: `outbox.${table}.deduplicate`,
      query: `SELECT sink_delivery_id FROM ${table}
              WHERE sink_delivery_id IN {deliveryIds:Array(String)}`,
      queryParams: { deliveryIds: [...byDeliveryId.keys()] },
    });
    const existingIds = new Set(delivered.rows.map((row) => row.sink_delivery_id));
    return [...byDeliveryId].filter(([id]) => !existingIds.has(id)).map(([, row]) => row);
  }
}

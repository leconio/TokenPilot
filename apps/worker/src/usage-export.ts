import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { once } from "node:events";
import { join, resolve } from "node:path";

import type { ClickHouseClient } from "@tokenpilot/clickhouse";

const EXPORT_PAGE_SIZE = 1_000;
const EXPORT_MAX_ROWS = 1_000_000;
const EXPORT_MAX_BYTES = 256 * 1024 * 1024;

type ClickHouseRow = Readonly<Record<string, unknown>>;

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function safeFilename(value: string): string {
  const result = value.replaceAll(/[^A-Za-z0-9._-]/gu, "_").slice(0, 180);
  if (result.length === 0) throw new TypeError("export filename identity is invalid");
  return `${result}.csv`;
}

async function writeChunk(
  stream: ReturnType<typeof createWriteStream>,
  chunk: string,
  state: { bytes: number },
): Promise<void> {
  state.bytes += Buffer.byteLength(chunk, "utf8");
  if (state.bytes > EXPORT_MAX_BYTES) throw new RangeError("export exceeds the 256 MiB limit");
  if (!stream.write(chunk, "utf8")) await once(stream, "drain");
}

function exactCount(value: unknown, label: string): number {
  const text = String(value ?? "");
  if (!/^\d+$/u.test(text)) throw new TypeError(`${label} returned an invalid count`);
  const count = Number(text);
  if (!Number.isSafeInteger(count)) throw new RangeError(`${label} exceeds the safe integer range`);
  return count;
}

async function queryRows<T extends ClickHouseRow>(
  clickhouse: ClickHouseClient,
  query: string,
  queryParams: Readonly<Record<string, unknown>>,
): Promise<readonly T[]> {
  const result = await clickhouse.query({
    query,
    query_params: { ...queryParams },
    format: "JSONEachRow",
    clickhouse_settings: {
      readonly: "1",
      result_overflow_mode: "throw",
    },
  });
  return result.json<T>();
}

const columns = [
  "event_id",
  "request_id",
  "attempt_id",
  "operation_id",
  "event_time",
  "application_version",
  "sdk_version",
  "connector_version",
  "config_version",
  "user_id",
  "display_user",
  "session_id",
  "conversation_id",
  "trace_id",
  "virtual_model",
  "model_id",
  "model_tag",
  "provider",
  "result_status",
  "provider_cost_status",
  "provider_cost",
  "provider_cost_currency",
  "aiu_status",
  "aiu_micros",
  "clickhouse_raw_synced_at",
  "clickhouse_official_synced_at",
] as const;

const exportCountQuery = `
  SELECT toString(count()) AS row_count
  FROM current_usage_events_raw AS event
  WHERE event.application_id = {application_id:String}
    AND event.event_time >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
    AND event.event_time < parseDateTime64BestEffort({to:String}, 3, 'UTC')
`;

const exportPageQuery = `
  SELECT
    event.event_id,
    event.request_id,
    event.attempt_id,
    event.operation_id,
    toString(event.event_time) AS event_time,
    event.application_version,
    event.sdk_version,
    event.connector_version,
    event.config_version,
    event.user_id,
    event.display_user,
    event.session_id,
    event.conversation_id,
    event.trace_id,
    event.virtual_model,
    event.model_id,
    event.model_tag,
    event.provider,
    event.status AS result_status,
    rating.provider_cost_status,
    rating.provider_cost,
    rating.provider_cost_currency,
    rating.aiu_status,
    rating.aiu_micros,
    rating.aiu_rating_count,
    rating.official_sync_count,
    toString(event.inserted_at) AS clickhouse_raw_synced_at,
    toString(rating.clickhouse_official_synced_at) AS clickhouse_official_synced_at
  FROM current_usage_events_raw AS event
  LEFT JOIN
  (
    SELECT
      application_id,
      source_event_id,
      argMaxIf(
        status,
        tuple(authority_outbox_id, rating_event_id),
        rating_kind = 'provider_cost'
      ) AS provider_cost_status,
      if(
        countIf(rating_kind = 'provider_cost' AND isNotNull(amount_decimal)) = 0,
        '',
        toString(sumIf(
          rating_sign * ifNull(amount_decimal, toDecimal128(0, 18)),
          rating_kind = 'provider_cost' AND isNotNull(amount_decimal)
        ))
      ) AS provider_cost,
      argMaxIf(
        ifNull(currency, ''),
        tuple(authority_outbox_id, rating_event_id),
        rating_kind = 'provider_cost' AND isNotNull(currency)
      ) AS provider_cost_currency,
      argMaxIf(
        status,
        tuple(authority_outbox_id, rating_event_id),
        rating_kind = 'aiu'
      ) AS aiu_status,
      if(
        countIf(rating_kind = 'aiu' AND isNotNull(aiu_micros)) = 0,
        '',
        toString(sumIf(
          rating_sign * ifNull(aiu_micros, toInt64(0)),
          rating_kind = 'aiu' AND isNotNull(aiu_micros)
        ))
      ) AS aiu_micros,
      countIf(rating_kind = 'aiu') AS aiu_rating_count,
      count() AS official_sync_count,
      max(inserted_at) AS clickhouse_official_synced_at
    FROM current_rating_events
    WHERE application_id = {application_id:String}
    GROUP BY application_id, source_event_id
  ) AS rating ON rating.application_id = event.application_id
    AND rating.source_event_id = event.event_id
  WHERE event.application_id = {application_id:String}
    AND event.event_time >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
    AND event.event_time < parseDateTime64BestEffort({to:String}, 3, 'UTC')
    AND ({after_event_id:String} = '' OR event.event_id > {after_event_id:String})
  ORDER BY event.event_id ASC
  LIMIT ${EXPORT_PAGE_SIZE}
`;

export async function countUnpricedUsage(input: {
  readonly clickhouse: ClickHouseClient;
}): Promise<number> {
  const rows = await queryRows<{ readonly unpriced_count: string | number }>(
    input.clickhouse,
    `
      SELECT toString(count()) AS unpriced_count
      FROM current_usage_events_raw AS event
      WHERE (event.application_id, event.event_id) NOT IN
        (
          SELECT application_id, source_event_id
          FROM current_rating_events
          WHERE rating_kind = 'provider_cost'
          GROUP BY application_id, source_event_id
          HAVING argMax(status, tuple(authority_outbox_id, rating_event_id))
            IN ('provisional', 'official')
        )
    `,
    {},
  );
  return exactCount(rows[0]?.unpriced_count, "ClickHouse unpriced usage count");
}

export async function generateUsageExport(input: {
  readonly clickhouse: ClickHouseClient;
  readonly applicationId: string;
  readonly outputDirectory: string;
  readonly identity: string;
  readonly from: Date;
  readonly to: Date;
}): Promise<{ readonly path: string; readonly rowCount: number; readonly bytes: number }> {
  const queryParams = {
    application_id: input.applicationId,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
  };
  const countRows = await queryRows<{ readonly row_count: string | number }>(
    input.clickhouse,
    exportCountQuery,
    queryParams,
  );
  const rowCount = exactCount(countRows[0]?.row_count, "ClickHouse usage export count");
  if (rowCount > EXPORT_MAX_ROWS) {
    throw new RangeError(`export exceeds the ${EXPORT_MAX_ROWS.toLocaleString("en-US")} row limit`);
  }
  const directory = resolve(input.outputDirectory);
  const path = join(directory, safeFilename(input.identity));
  const temporary = `${path}.tmp-${process.pid}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stream = createWriteStream(temporary, { encoding: "utf8", flags: "wx", mode: 0o600 });
  const state = { bytes: 0 };
  let exportedRows = 0;
  let afterEventId = "";
  let hasMore: boolean;
  try {
    await writeChunk(stream, columns.map(csvCell).join(",") + "\n", state);
    do {
      const events = await queryRows<ClickHouseRow>(input.clickhouse, exportPageQuery, {
        ...queryParams,
        after_event_id: afterEventId,
      });
      for (const event of events) {
        const aiuRatingCount = exactCount(
          event.aiu_rating_count ?? 0,
          "ClickHouse AIU rating count",
        );
        const officialSyncCount = exactCount(
          event.official_sync_count ?? 0,
          "ClickHouse official rating count",
        );
        await writeChunk(
          stream,
          [
            event.event_id,
            event.request_id,
            event.attempt_id,
            event.operation_id,
            event.event_time,
            event.application_version,
            event.sdk_version,
            event.connector_version,
            event.config_version,
            event.user_id,
            event.display_user,
            event.session_id,
            event.conversation_id,
            event.trace_id,
            event.virtual_model,
            event.model_id,
            event.model_tag,
            event.provider,
            event.result_status,
            event.provider_cost_status,
            event.provider_cost,
            event.provider_cost_currency,
            aiuRatingCount === 0 ? null : event.aiu_status,
            aiuRatingCount === 0 ? null : event.aiu_micros,
            event.clickhouse_raw_synced_at,
            officialSyncCount === 0 ? null : event.clickhouse_official_synced_at,
          ]
            .map(csvCell)
            .join(",") + "\n",
          state,
        );
        exportedRows += 1;
      }
      const lastEventId = events.at(-1)?.event_id;
      hasMore = events.length === EXPORT_PAGE_SIZE;
      if (!hasMore) break;
      if (typeof lastEventId !== "string" || lastEventId.length === 0) {
        throw new TypeError("ClickHouse usage export page returned an invalid event cursor");
      }
      afterEventId = lastEventId;
    } while (hasMore);
    if (exportedRows !== rowCount) throw new Error("export row count changed during generation");
    const closed = once(stream, "close");
    stream.end();
    await closed;
    await rename(temporary, path);
    return { path, rowCount, bytes: state.bytes };
  } catch (error) {
    stream.destroy();
    await rm(temporary, { force: true });
    throw error;
  }
}

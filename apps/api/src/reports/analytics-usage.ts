import type { UsagePageEnvelope, UsageReportItem } from "@tokenpilot/contracts";

import { reportCount, usagePageEnvelope, usageReportItem } from "./data.js";
import type { ClickHouseExecute } from "./clickhouse-query.js";
import { encodeUsageCursor, type ReportQuery } from "./query.js";

function pageRatingProjection(): string {
  return `
    SELECT
      rating.source_event_id,
      argMaxIf(
        rating.status,
        tuple(rating.authority_outbox_id, rating.rating_event_id),
        rating.rating_kind = 'provider_cost'
      ) AS provider_cost_status,
      argMaxIf(
        ifNull(rating.currency, ''),
        tuple(rating.authority_outbox_id, rating.rating_event_id),
        rating.rating_kind = 'provider_cost'
      ) AS provider_cost_currency,
      sumIf(
        toInt64(rating.rating_sign) * ifNull(rating.amount_decimal, toDecimal128(0, 18)),
        rating.rating_kind = 'provider_cost' AND isNotNull(rating.amount_decimal)
      ) AS provider_cost_amount,
      countIf(
        rating.rating_kind = 'provider_cost' AND isNotNull(rating.amount_decimal)
      ) AS provider_cost_amount_count,
      argMaxIf(
        rating.status,
        tuple(rating.authority_outbox_id, rating.rating_event_id),
        rating.rating_kind = 'aiu'
      ) AS aiu_status,
      sumIf(
        toInt64(rating.rating_sign) * ifNull(rating.aiu_micros, toInt64(0)),
        rating.rating_kind = 'aiu' AND isNotNull(rating.aiu_micros)
      ) AS aiu_micros,
      countIf(rating.rating_kind = 'aiu' AND isNotNull(rating.aiu_micros)) AS aiu_amount_count
    FROM current_rating_events AS rating
    WHERE rating.event_time >= (SELECT min(event_time) FROM page_events)
      AND rating.event_time <= (SELECT max(event_time) FROM page_events)
      AND (rating.event_time, rating.source_event_id) IN (
      SELECT event_time, event_id FROM page_events
    )
    GROUP BY rating.source_event_id
  `;
}

function pageUsageProjection(): string {
  return `
    SELECT
      line.event_id,
      toString(sumIf(line.quantity, line.usage_type IN (
        'uncached_input_token', 'cache_read_input_token',
        'cache_write_input_token', 'embedding_token'
      ))) AS input_tokens,
      toString(sumIf(line.quantity, line.usage_type IN (
        'cache_read_input_token', 'cache_write_input_token'
      ))) AS cached_input_tokens,
      toString(sumIf(line.quantity, line.usage_type IN (
        'output_token', 'reasoning_output_token'
      ))) AS output_tokens,
      toString(sumIf(line.quantity, line.usage_type = 'reasoning_output_token'))
        AS reasoning_output_tokens,
      toString(sumIf(line.quantity, line.usage_type IN (
        'uncached_input_token', 'cache_read_input_token',
        'cache_write_input_token', 'embedding_token',
        'output_token', 'reasoning_output_token'
      ))) AS total_tokens
    FROM current_usage_lines AS line
    WHERE line.application_id = {application_id:String}
      AND (line.event_time, line.event_id) IN (
        SELECT event_time, event_id FROM page_events
      )
    GROUP BY line.event_id
  `;
}

function cursorPredicate(query: ReportQuery): string {
  if (query.usageCursor === null) return "";
  return `
    AND (
      event.event_time < parseDateTime64BestEffort({cursor_event_time:String}, 3, 'UTC')
      OR (
        event.event_time = parseDateTime64BestEffort({cursor_event_time:String}, 3, 'UTC')
        AND event.event_id < {cursor_event_id:String}
      )
    )`;
}

export async function queryAnalyticsUsage(
  execute: ClickHouseExecute,
  query: ReportQuery,
): Promise<UsagePageEnvelope<UsageReportItem>> {
  const [rows, totals] = await Promise.all([
    execute(
      (where) => `
        WITH page_events AS
        (
          SELECT
            event.event_id,
            event.request_id,
            event.attempt_id,
            event.attempt_index,
            event.is_final_attempt,
            event.operation_id,
            event.event_time,
            event.received_at,
            event.schema_version,
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
            event.connection_id,
            event.connection_driver,
            event.request_model,
            event.provider,
            event.status,
            event.route_reason,
            event.fallback_from,
            event.latency_ms,
            event.analytics_dimensions,
            event.event_text_properties,
            event.event_number_properties,
            event.event_boolean_properties,
            event.event_datetime_properties,
            event.event_enum_properties,
            event.event_text_list_properties,
            event.user_text_properties,
            event.user_number_properties,
            event.user_boolean_properties,
            event.user_datetime_properties,
            event.user_enum_properties,
            event.user_text_list_properties
          FROM current_usage_events_raw AS event
          WHERE ${where}${cursorPredicate(query)}
          ORDER BY event.event_time DESC, event.event_id DESC
          LIMIT ${query.pageSize}
        ),
        page_ratings AS
        (${pageRatingProjection()}),
        page_usage AS
        (${pageUsageProjection()})
        SELECT
          event.event_id AS event_id,
          event.request_id AS request_id,
          event.attempt_id AS attempt_id,
          event.attempt_index AS attempt_index,
          event.is_final_attempt AS is_final_attempt,
          nullIf(event.operation_id, '') AS operation_id,
          toString(event.event_time) AS event_time,
          toString(event.received_at) AS received_at,
          event.schema_version AS schema_version,
          nullIf(event.application_version, '') AS application_version,
          nullIf(event.sdk_version, '') AS sdk_version,
          nullIf(event.connector_version, '') AS connector_version,
          nullIf(event.config_version, '') AS config_version,
          event.user_id AS user_id,
          nullIf(event.display_user, '') AS display_user,
          nullIf(event.session_id, '') AS session_id,
          nullIf(event.conversation_id, '') AS conversation_id,
          nullIf(event.trace_id, '') AS trace_id,
          nullIf(event.virtual_model, '') AS virtual_model,
          nullIf(event.model_id, '') AS model_id,
          nullIf(event.connection_id, '') AS connection_id,
          nullIf(event.connection_driver, '') AS connection_driver,
          event.request_model AS request_model,
          nullIf(event.provider, '') AS provider,
          event.status AS status,
          nullIf(event.route_reason, '') AS route_reason,
          nullIf(event.fallback_from, '') AS fallback_from,
          event.latency_ms AS latency_ms,
          ifNull(usage.input_tokens, '0') AS input_tokens,
          ifNull(usage.cached_input_tokens, '0') AS cached_input_tokens,
          ifNull(usage.output_tokens, '0') AS output_tokens,
          ifNull(usage.reasoning_output_tokens, '0') AS reasoning_output_tokens,
          ifNull(usage.total_tokens, '0') AS total_tokens,
          nullIf(rating.provider_cost_status, '') AS provider_cost_status,
          if(rating.provider_cost_amount_count = 0, NULL, toString(rating.provider_cost_amount))
            AS provider_cost_amount,
          nullIf(rating.provider_cost_currency, '') AS provider_cost_currency,
          nullIf(rating.aiu_status, '') AS aiu_status,
          if(rating.aiu_amount_count = 0, NULL, toString(rating.aiu_micros)) AS aiu_micros,
          CAST(NULL, 'Nullable(UInt8)') AS aiu_chargeable,
          nullIf(event.analytics_dimensions['quota_status'], '') AS quota_status,
          event.event_text_properties AS event_text_properties,
          event.event_number_properties AS event_number_properties,
          event.event_boolean_properties AS event_boolean_properties,
          event.event_datetime_properties AS event_datetime_properties,
          event.event_enum_properties AS event_enum_properties,
          event.event_text_list_properties AS event_text_list_properties,
          event.user_text_properties AS user_text_properties,
          event.user_number_properties AS user_number_properties,
          event.user_boolean_properties AS user_boolean_properties,
          event.user_datetime_properties AS user_datetime_properties,
          event.user_enum_properties AS user_enum_properties,
          event.user_text_list_properties AS user_text_list_properties
        FROM page_events AS event
        LEFT JOIN page_ratings AS rating ON rating.source_event_id = event.event_id
        LEFT JOIN page_usage AS usage ON usage.event_id = event.event_id
        ORDER BY event.event_time DESC, event.event_id DESC
      `,
    ),
    query.knownUsageTotal === undefined
      ? execute(
          (where) => `
        SELECT count() AS total
        FROM current_usage_events_raw AS event
        WHERE ${where}
      `,
        )
      : Promise.resolve([{ total: query.knownUsageTotal }]),
  ]);
  const items = rows.map((row) => usageReportItem(row));
  const total = reportCount(totals[0]?.total ?? 0);
  const position = (query.usageCursor?.position ?? 0) + items.length;
  const last = items.at(-1);
  const nextCursor =
    last !== undefined && position < total
      ? encodeUsageCursor({ eventTime: last.event_time, eventId: last.event_id, position })
      : null;
  return usagePageEnvelope(items, query.pageSize, total, nextCursor);
}

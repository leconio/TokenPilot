import { ServiceUnavailableException } from "@nestjs/common";

import type { ClickHouseClient } from "@tokenpilot/clickhouse";
import { Prisma } from "@tokenpilot/db";

import { metricDecimal, metricInteger } from "./user-metrics-values.js";

interface TrendRow {
  readonly bucket?: unknown;
  readonly calls?: unknown;
  readonly tokens?: unknown;
  readonly aiu_micros?: unknown;
}

interface ModelRow extends TrendRow {
  readonly request_model?: unknown;
  readonly virtual_model?: unknown;
}

interface CostRow {
  readonly request_model?: unknown;
  readonly currency?: unknown;
  readonly amount?: unknown;
}

interface HistoryRow {
  readonly event_id?: unknown;
  readonly request_id?: unknown;
  readonly event_time?: unknown;
  readonly virtual_model?: unknown;
  readonly request_model?: unknown;
  readonly status?: unknown;
}

export interface ApplicationUserAnalytics {
  readonly trend: readonly {
    readonly bucket: string;
    readonly calls: number;
    readonly tokens: string;
    readonly aiu_micros: string;
  }[];
  readonly models: readonly {
    readonly request_model: string;
    readonly virtual_model: string;
    readonly calls: number;
    readonly tokens: string;
    readonly aiu_micros: string;
    readonly costs: readonly { readonly currency: string; readonly amount: string }[];
  }[];
  readonly costs: readonly { readonly currency: string; readonly amount: string }[];
  readonly recent_calls: readonly {
    readonly event_id: string;
    readonly request_id: string;
    readonly event_time: string;
    readonly virtual_model: string;
    readonly request_model: string;
    readonly status: string;
  }[];
}

export async function queryApplicationUserAnalytics(
  clickhouse: ClickHouseClient,
  applicationId: string,
  externalUserId: string,
  from: Date,
  to: Date,
): Promise<ApplicationUserAnalytics> {
  const range = {
    application_id: applicationId,
    user_id: externalUserId,
    from: from.toISOString(),
    to: to.toISOString(),
  };
  const where = `application_id = {application_id:String}
    AND user_id = {user_id:String}
    AND event_time >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
    AND event_time < parseDateTime64BestEffort({to:String}, 3, 'UTC')`;
  try {
    const [trendResult, modelResult, costResult, historyResult] = await Promise.all([
      clickhouse.query({
        query: `
          SELECT
            formatDateTime(bucket, '%Y-%m-%dT%H:%i:%SZ', 'UTC') AS bucket,
            toUInt64(sum(calls)) AS calls,
            toString(sum(tokens)) AS tokens,
            toString(sum(aiu_micros)) AS aiu_micros
          FROM (
            SELECT toStartOfDay(event_time) AS bucket, uniqExact(request_id) AS calls,
              toDecimal128(0, 9) AS tokens, toInt64(0) AS aiu_micros
            FROM current_usage_events_raw WHERE ${where} GROUP BY bucket
            UNION ALL
            SELECT toStartOfDay(event_time) AS bucket, toUInt64(0) AS calls,
              sumIf(quantity, unit = 'token') AS tokens, toInt64(0) AS aiu_micros
            FROM current_usage_lines WHERE ${where} GROUP BY bucket
            UNION ALL
            SELECT toStartOfDay(event_time) AS bucket, toUInt64(0) AS calls,
              toDecimal128(0, 9) AS tokens,
              sumIf(rating_sign * assumeNotNull(aiu_micros), rating_kind = 'aiu' AND isNotNull(aiu_micros)) AS aiu_micros
            FROM current_rating_events WHERE ${where} GROUP BY bucket
          )
          GROUP BY bucket ORDER BY bucket LIMIT 367
        `,
        query_params: range,
        format: "JSONEachRow",
      }),
      clickhouse.query({
        query: `
          SELECT request_model, virtual_model,
            toUInt64(sum(calls)) AS calls,
            toString(sum(tokens)) AS tokens,
            toString(sum(aiu_micros)) AS aiu_micros
          FROM (
            SELECT request_model, virtual_model, uniqExact(request_id) AS calls,
              toDecimal128(0, 9) AS tokens, toInt64(0) AS aiu_micros
            FROM current_usage_events_raw WHERE ${where} GROUP BY request_model, virtual_model
            UNION ALL
            SELECT request_model, virtual_model, toUInt64(0) AS calls,
              sumIf(quantity, unit = 'token') AS tokens, toInt64(0) AS aiu_micros
            FROM current_usage_lines WHERE ${where} GROUP BY request_model, virtual_model
            UNION ALL
            SELECT request_model, virtual_model, toUInt64(0) AS calls,
              toDecimal128(0, 9) AS tokens,
              sumIf(rating_sign * assumeNotNull(aiu_micros), rating_kind = 'aiu' AND isNotNull(aiu_micros)) AS aiu_micros
            FROM current_rating_events WHERE ${where} GROUP BY request_model, virtual_model
          )
          GROUP BY request_model, virtual_model
          ORDER BY aiu_micros DESC, request_model LIMIT 200
        `,
        query_params: range,
        format: "JSONEachRow",
      }),
      clickhouse.query({
        query: `
          SELECT request_model, assumeNotNull(currency) AS currency,
            toString(sum(rating_sign * assumeNotNull(amount_decimal))) AS amount
          FROM current_rating_events
          WHERE ${where}
            AND rating_kind = 'provider_cost'
            AND isNotNull(currency) AND isNotNull(amount_decimal)
          GROUP BY request_model, currency ORDER BY request_model, currency LIMIT 1000
        `,
        query_params: range,
        format: "JSONEachRow",
      }),
      clickhouse.query({
        query: `
          SELECT event_id, request_id,
            formatDateTime(event_time, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS event_time,
            virtual_model, request_model, status
          FROM current_usage_events_raw
          WHERE ${where}
          ORDER BY event_time DESC, event_id DESC LIMIT 100
        `,
        query_params: range,
        format: "JSONEachRow",
      }),
    ]);
    const [trendRows, modelRows, costRows, historyRows] = await Promise.all([
      trendResult.json<TrendRow>(),
      modelResult.json<ModelRow>(),
      costResult.json<CostRow>(),
      historyResult.json<HistoryRow>(),
    ]);
    const costsByModel = new Map<string, Array<{ currency: string; amount: string }>>();
    const allCosts = new Map<string, Prisma.Decimal>();
    for (const row of costRows) {
      if (typeof row.request_model !== "string" || typeof row.currency !== "string") continue;
      const amount = metricDecimal(row.amount);
      costsByModel.set(row.request_model, [
        ...(costsByModel.get(row.request_model) ?? []),
        { currency: row.currency, amount: amount.toString() },
      ]);
      allCosts.set(row.currency, (allCosts.get(row.currency) ?? new Prisma.Decimal(0)).add(amount));
    }
    return {
      trend: trendRows.flatMap((row) =>
        typeof row.bucket !== "string"
          ? []
          : [
              {
                bucket: row.bucket,
                calls: Number(metricInteger(row.calls)),
                tokens: metricDecimal(row.tokens).toString(),
                aiu_micros: metricInteger(row.aiu_micros).toString(),
              },
            ],
      ),
      models: modelRows.flatMap((row) =>
        typeof row.request_model !== "string"
          ? []
          : [
              {
                request_model: row.request_model,
                virtual_model: typeof row.virtual_model === "string" ? row.virtual_model : "",
                calls: Number(metricInteger(row.calls)),
                tokens: metricDecimal(row.tokens).toString(),
                aiu_micros: metricInteger(row.aiu_micros).toString(),
                costs: costsByModel.get(row.request_model) ?? [],
              },
            ],
      ),
      costs: [...allCosts.entries()].map(([currency, amount]) => ({
        currency,
        amount: amount.toString(),
      })),
      recent_calls: historyRows.flatMap((row) =>
        typeof row.event_id !== "string" ||
        typeof row.request_id !== "string" ||
        typeof row.event_time !== "string"
          ? []
          : [
              {
                event_id: row.event_id,
                request_id: row.request_id,
                event_time: row.event_time,
                virtual_model: typeof row.virtual_model === "string" ? row.virtual_model : "",
                request_model: typeof row.request_model === "string" ? row.request_model : "",
                status: typeof row.status === "string" ? row.status : "unknown",
              },
            ],
      ),
    };
  } catch {
    throw new ServiceUnavailableException("User analytics are temporarily unavailable");
  }
}

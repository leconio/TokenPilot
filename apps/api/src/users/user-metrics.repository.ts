import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";

import type { ClickHouseClient } from "@tokenpilot/clickhouse";
import type { Prisma, PropertyDataType } from "@tokenpilot/db";

import { CLICKHOUSE_CLIENT } from "../tokens.js";
import {
  queryApplicationUserAnalytics,
  type ApplicationUserAnalytics,
} from "./user-analytics.query.js";
import { metricDecimal, metricInteger } from "./user-metrics-values.js";

export type { ApplicationUserAnalytics } from "./user-analytics.query.js";

export interface ApplicationUserMetrics {
  readonly calls: number;
  readonly tokens: Prisma.Decimal;
  readonly aiuMicros: bigint;
  readonly cost: Prisma.Decimal;
}

interface MetricsRow {
  readonly user_id?: unknown;
  readonly calls?: unknown;
  readonly tokens?: unknown;
  readonly aiu_micros?: unknown;
  readonly cost?: unknown;
}

export interface ApplicationUserSearchInput {
  readonly page: number;
  readonly limit: number;
  readonly search?: string;
  readonly status?: "active" | "blocked";
  readonly tag?: string;
  readonly externalUserIds?: readonly string[];
  readonly minimumCalls?: number;
  readonly minimumTokens?: string;
  readonly minimumAiuMicros?: bigint;
  readonly property?: {
    readonly key: string;
    readonly value: string;
    readonly dataType: PropertyDataType;
  };
}

export interface ApplicationUserSearchResult {
  readonly rows: readonly {
    readonly id: string;
    readonly externalId: string;
    readonly metrics: ApplicationUserMetrics;
  }[];
  readonly total: number;
}

@Injectable()
export class ApplicationUserMetricsRepository {
  constructor(@Inject(CLICKHOUSE_CLIENT) private readonly clickhouse: ClickHouseClient) {}

  async search(
    applicationId: string,
    input: ApplicationUserSearchInput,
  ): Promise<ApplicationUserSearchResult> {
    if (input.externalUserIds?.length === 0) return { rows: [], total: 0 };
    const conditions = ["profile.application_id = {application_id:String}"];
    const params: Record<string, string | number | readonly string[]> = {
      application_id: applicationId,
      limit: input.limit,
      offset: (input.page - 1) * input.limit,
    };
    if (input.search !== undefined) {
      conditions.push(`(
        positionCaseInsensitiveUTF8(profile.user_id, {search:String}) > 0
        OR positionCaseInsensitiveUTF8(profile.display_user, {search:String}) > 0
        OR arrayExists(tag -> positionCaseInsensitiveUTF8(tag, {search:String}) > 0, profile.tags)
      )`);
      params.search = input.search;
    }
    if (input.status !== undefined) {
      conditions.push("profile.status = {status:String}");
      params.status = input.status;
    }
    if (input.tag !== undefined) {
      conditions.push("has(profile.tags, {tag:String})");
      params.tag = input.tag;
    }
    if (input.externalUserIds !== undefined) {
      conditions.push("profile.user_id IN {user_ids:Array(String)}");
      params.user_ids = input.externalUserIds;
    }
    if (input.minimumCalls !== undefined) {
      conditions.push("ifNull(metric.calls, 0) >= {minimum_calls:UInt64}");
      params.minimum_calls = input.minimumCalls;
    }
    if (input.minimumTokens !== undefined) {
      conditions.push("ifNull(metric.tokens, 0) >= toDecimal128({minimum_tokens:String}, 9)");
      params.minimum_tokens = input.minimumTokens;
    }
    if (input.minimumAiuMicros !== undefined) {
      conditions.push("ifNull(metric.aiu_micros, 0) >= toInt64({minimum_aiu_micros:String})");
      params.minimum_aiu_micros = input.minimumAiuMicros.toString();
    }
    if (input.property !== undefined) {
      const suffix = {
        TEXT: "text_properties",
        NUMBER: "number_properties",
        BOOLEAN: "boolean_properties",
        DATETIME: "datetime_properties",
        ENUM: "enum_properties",
        TEXT_LIST: "text_list_properties",
      }[input.property.dataType];
      const map = `profile.user_${suffix}`;
      const comparison = {
        TEXT: `${map}[{property_key:String}] = {property_value:String}`,
        NUMBER: `${map}[{property_key:String}] = toFloat64({property_value:String})`,
        BOOLEAN: `${map}[{property_key:String}] = {property_boolean:UInt8}`,
        DATETIME: `${map}[{property_key:String}] = parseDateTime64BestEffort({property_value:String}, 3, 'UTC')`,
        ENUM: `${map}[{property_key:String}] = {property_value:String}`,
        TEXT_LIST: `has(${map}[{property_key:String}], {property_value:String})`,
      }[input.property.dataType];
      conditions.push(`mapContains(${map}, {property_key:String}) AND ${comparison}`);
      params.property_key = input.property.key;
      if (input.property.dataType === "BOOLEAN") {
        params.property_boolean = input.property.value === "true" ? 1 : 0;
      } else {
        params.property_value = input.property.value;
      }
    }
    try {
      const result = await this.clickhouse.query({
        query: `
          WITH usage_metrics AS (
            SELECT user_id,
              toUInt64(sum(calls)) AS calls,
              sum(tokens) AS tokens,
              toInt64(sum(aiu_micros)) AS aiu_micros,
              sum(cost) AS cost
            FROM (
              SELECT user_id, uniqExact(request_id) AS calls, toDecimal128(0, 9) AS tokens,
                toInt64(0) AS aiu_micros, toDecimal128(0, 18) AS cost
              FROM current_usage_events_raw
              WHERE application_id = {application_id:String} GROUP BY user_id
              UNION ALL
              SELECT user_id, toUInt64(0) AS calls, sumIf(quantity, unit = 'token') AS tokens,
                toInt64(0) AS aiu_micros, toDecimal128(0, 18) AS cost
              FROM current_usage_lines
              WHERE application_id = {application_id:String} GROUP BY user_id
              UNION ALL
              SELECT user_id, toUInt64(0) AS calls, toDecimal128(0, 9) AS tokens,
                sumIf(rating_sign * assumeNotNull(aiu_micros), rating_kind = 'aiu' AND isNotNull(aiu_micros)) AS aiu_micros,
                sumIf(rating_sign * assumeNotNull(amount_decimal), rating_kind = 'provider_cost' AND isNotNull(amount_decimal)) AS cost
              FROM current_rating_events
              WHERE application_id = {application_id:String} GROUP BY user_id
            ) GROUP BY user_id
          )
          SELECT
            profile.user_record_id,
            profile.user_id,
            ifNull(metric.calls, 0) AS calls,
            toString(ifNull(metric.tokens, 0)) AS tokens,
            toString(ifNull(metric.aiu_micros, 0)) AS aiu_micros,
            toString(ifNull(metric.cost, 0)) AS cost,
            count() OVER () AS total
          FROM current_application_user_profiles AS profile
          LEFT JOIN usage_metrics AS metric ON metric.user_id = profile.user_id
          WHERE ${conditions.join(" AND ")}
          ORDER BY profile.last_seen_at DESC, profile.user_id
          LIMIT {limit:UInt32} OFFSET {offset:UInt64}
        `,
        query_params: params,
        format: "JSONEachRow",
      });
      const rows = await result.json<
        MetricsRow & {
          readonly user_record_id?: unknown;
          readonly total?: unknown;
        }
      >();
      return {
        rows: rows.flatMap((row) =>
          typeof row.user_record_id !== "string" || typeof row.user_id !== "string"
            ? []
            : [
                {
                  id: row.user_record_id,
                  externalId: row.user_id,
                  metrics: {
                    calls: Number(metricInteger(row.calls)),
                    tokens: metricDecimal(row.tokens),
                    aiuMicros: metricInteger(row.aiu_micros),
                    cost: metricDecimal(row.cost),
                  },
                },
              ],
        ),
        total: Number(metricInteger(rows[0]?.total)),
      };
    } catch {
      throw new ServiceUnavailableException("User analytics are temporarily unavailable");
    }
  }

  async load(
    applicationId: string,
    externalUserIds: readonly string[],
  ): Promise<ReadonlyMap<string, ApplicationUserMetrics>> {
    if (externalUserIds.length === 0) return new Map();
    try {
      const result = await this.clickhouse.query({
        query: `
          SELECT
            user_id,
            toUInt64(sum(calls)) AS calls,
            toString(sum(tokens)) AS tokens,
            toString(sum(aiu_micros)) AS aiu_micros,
            toString(sum(cost)) AS cost
          FROM (
            SELECT user_id, count() AS calls, toDecimal128(0, 9) AS tokens,
              toInt64(0) AS aiu_micros, toDecimal128(0, 18) AS cost
            FROM current_usage_events_raw
            WHERE application_id = {application_id:String}
              AND user_id IN {user_ids:Array(String)}
            GROUP BY user_id
            UNION ALL
            SELECT user_id, toUInt64(0) AS calls,
              sumIf(quantity, unit = 'token') AS tokens,
              toInt64(0) AS aiu_micros, toDecimal128(0, 18) AS cost
            FROM current_usage_lines
            WHERE application_id = {application_id:String}
              AND user_id IN {user_ids:Array(String)}
            GROUP BY user_id
            UNION ALL
            SELECT user_id, toUInt64(0) AS calls, toDecimal128(0, 9) AS tokens,
              sumIf(rating_sign * assumeNotNull(aiu_micros), rating_kind = 'aiu' AND isNotNull(aiu_micros)) AS aiu_micros,
              sumIf(rating_sign * assumeNotNull(amount_decimal), rating_kind = 'provider_cost' AND isNotNull(amount_decimal)) AS cost
            FROM current_rating_events
            WHERE application_id = {application_id:String}
              AND user_id IN {user_ids:Array(String)}
            GROUP BY user_id
          )
          GROUP BY user_id
        `,
        query_params: { application_id: applicationId, user_ids: [...externalUserIds] },
        format: "JSONEachRow",
      });
      const rows = await result.json<MetricsRow>();
      return new Map(
        rows.flatMap((row) => {
          if (typeof row.user_id !== "string" || row.user_id.length === 0) return [];
          return [
            [
              row.user_id,
              {
                calls: Number(metricInteger(row.calls)),
                tokens: metricDecimal(row.tokens),
                aiuMicros: metricInteger(row.aiu_micros),
                cost: metricDecimal(row.cost),
              },
            ] as const,
          ];
        }),
      );
    } catch {
      throw new ServiceUnavailableException("User analytics are temporarily unavailable");
    }
  }

  async detail(
    applicationId: string,
    externalUserId: string,
    from: Date,
    to: Date,
  ): Promise<ApplicationUserAnalytics> {
    return queryApplicationUserAnalytics(this.clickhouse, applicationId, externalUserId, from, to);
  }
}

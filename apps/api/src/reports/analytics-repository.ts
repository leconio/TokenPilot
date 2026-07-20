import {
  GatewayTimeoutException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";

import type {
  AiuReportData,
  ActivityReportData,
  OverviewReportData,
  PipelineHealthReportData,
  ProviderCostReportData,
  UsagePageEnvelope,
  UsageReportItem,
} from "@tokenpilot/contracts";
import type { ClickHouseClient } from "@tokenpilot/clickhouse";

import { CLICKHOUSE_CLIENT } from "../tokens.js";
import { reportCount, reportInstant, type ReportRow } from "./data.js";
import { clickHouseFilters, type ClickHouseExecute } from "./clickhouse-query.js";
import { queryAnalyticsOverview, queryAnalyticsPipelineHealth } from "./analytics-report-data.js";
import { queryAnalyticsAiu } from "./analytics-aiu.js";
import { queryAnalyticsActivity } from "./analytics-activity.js";
import { queryAnalyticsProviderCost } from "./analytics-provider-cost.js";
import { queryAnalyticsUsage } from "./analytics-usage.js";
import type { ReportQuery } from "./query.js";

export interface AnalyticsWatermark {
  readonly watermark: string | null;
  readonly lag_seconds: number | null;
}

@Injectable()
export class AnalyticsReportRepository {
  public constructor(@Inject(CLICKHOUSE_CLIENT) private readonly clickhouse: ClickHouseClient) {}

  public overview(query: ReportQuery): Promise<OverviewReportData> {
    return queryAnalyticsOverview(this.executor(query), query);
  }

  public usage(query: ReportQuery): Promise<UsagePageEnvelope<UsageReportItem>> {
    return queryAnalyticsUsage(this.executor(query), query);
  }

  public providerCost(query: ReportQuery): Promise<ProviderCostReportData> {
    return queryAnalyticsProviderCost(this.executor(query), query);
  }

  public aiu(query: ReportQuery): Promise<AiuReportData> {
    return queryAnalyticsAiu(this.executor(query), query);
  }

  public activity(query: ReportQuery): Promise<ActivityReportData> {
    return queryAnalyticsActivity(this.executor(query), query);
  }

  public cache(query: ReportQuery): Promise<readonly ReportRow[]> {
    return this.execute(
      query,
      (where) => `
        SELECT
          if(mapContains(event.analytics_dimensions, 'response_cache_hit'),
            event.analytics_dimensions['response_cache_hit'], 'unknown') AS cache_status,
          count() AS event_count
        FROM current_usage_events_raw AS event
        WHERE ${where}
        GROUP BY cache_status
        ORDER BY event_count DESC, cache_status
      `,
    );
  }

  public fallback(query: ReportQuery): Promise<readonly ReportRow[]> {
    return this.execute(
      query,
      (where) => `
        SELECT event.fallback_from, event.virtual_model, event.status, count() AS event_count
        FROM current_usage_events_raw AS event
        WHERE ${where} AND notEmpty(event.fallback_from)
        GROUP BY event.fallback_from, event.virtual_model, event.status
        ORDER BY event_count DESC, event.fallback_from, event.virtual_model
        LIMIT 500
      `,
    );
  }

  public dimensions(query: ReportQuery): Promise<readonly ReportRow[]> {
    return this.execute(
      query,
      (where) => `
        SELECT dimension_key, dimension_value, count() AS event_count
        FROM
        (
          SELECT
            arrayJoin(
              arrayMap(
                (key, value) -> tuple(key, value),
                mapKeys(event.analytics_dimensions),
                mapValues(event.analytics_dimensions)
              )
            ) AS dimension,
            tupleElement(dimension, 1) AS dimension_key,
            tupleElement(dimension, 2) AS dimension_value
          FROM current_usage_events_raw AS event
          WHERE ${where}
        )
        GROUP BY dimension_key, dimension_value
        ORDER BY event_count DESC, dimension_key, dimension_value
        LIMIT 500
      `,
    );
  }

  public pipelineHealth(
    query: ReportQuery,
    dependencies: Readonly<{
      postgres: "healthy";
      redis: "healthy";
      clickhouse: "healthy";
    }>,
  ): Promise<PipelineHealthReportData> {
    return queryAnalyticsPipelineHealth(this.executor(query), dependencies);
  }

  public async watermark(query: ReportQuery): Promise<AnalyticsWatermark> {
    const rows = await this.execute(
      query,
      (where) => `
        SELECT
          if(count() = 0, NULL, toString(max(event.event_time))) AS watermark,
          if(count() = 0, NULL,
            greatest(dateDiff('second', max(event.event_time), now64(3)), 0)) AS lag_seconds
        FROM current_usage_events_raw AS event
        WHERE ${where}
      `,
    );
    const row = rows[0] ?? {};
    return {
      watermark: reportInstant(row.watermark),
      lag_seconds:
        row.lag_seconds === null || row.lag_seconds === undefined
          ? null
          : reportCount(row.lag_seconds),
    };
  }

  private executor(query: ReportQuery): ClickHouseExecute {
    return (statement) => this.execute(query, statement);
  }

  private async execute(
    query: ReportQuery,
    statement: (where: string) => string,
  ): Promise<readonly ReportRow[]> {
    const filter = clickHouseFilters(query);
    try {
      const result = await this.clickhouse.query({
        query: statement(filter.sql),
        query_params: filter.params,
        format: "JSONEachRow",
      });
      return await result.json<ReportRow>();
    } catch (error) {
      const diagnostic = error instanceof Error ? `${error.name} ${error.message}` : "";
      if (/timeout|timed out|TIMEOUT_EXCEEDED/iu.test(diagnostic)) {
        throw new GatewayTimeoutException("统计查询超时，请缩小时间范围或增加筛选条件");
      }
      throw new ServiceUnavailableException("统计服务暂时不可用，请稍后重试");
    }
  }
}

import { Readable } from "node:stream";

import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from "@nestjs/common";

import { reportEnvelopeSchema, type ReportEnvelope } from "@tokenpilot/contracts";
import type { DatabaseClient } from "@tokenpilot/db";

import { HealthService } from "../health.controller.js";
import { AuditContextService } from "../audit-context.js";
import { DATABASE_CLIENT } from "../tokens.js";
import {
  decodeUsageCursor,
  parseReportQuery,
  type ReportPagination,
  type ReportQuery,
} from "./query.js";
import { AnalyticsReportRepository } from "./analytics-repository.js";
import { resolveReportProperties } from "./property-resolution.js";
import {
  loadUsageOutputPolicy,
  maskUsageItem,
  maskUsagePage,
  usageCsvHeader,
  usageItemsToCsvRows,
} from "./usage-output.js";

const MAX_EXPORT_ROWS = 100_000;
const activityMetrics = new Set([
  "requests",
  "tokens",
  "unique_users",
  "success_rate",
  "average_latency",
]);

export type ReportKind =
  | "overview"
  | "usage"
  | "activity"
  | "provider-cost"
  | "aiu"
  | "cache"
  | "fallback"
  | "dimensions"
  | "pipeline-health";

@Injectable()
export class ReportsService {
  public constructor(
    @Inject(AnalyticsReportRepository) private readonly analytics: AnalyticsReportRepository,
    @Inject(HealthService) private readonly health: HealthService,
    @Inject(AuditContextService) private readonly context: AuditContextService,
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
  ) {}

  public async report(
    kind: ReportKind,
    rawQuery: Readonly<Record<string, unknown>>,
  ): Promise<ReportEnvelope> {
    const pagination: ReportPagination =
      kind === "usage"
        ? "usage"
        : kind === "activity"
          ? "activity"
          : kind === "provider-cost"
            ? "provider_cost"
            : kind === "aiu"
              ? "aiu"
              : "none";
    const applicationId = this.context.current().applicationId;
    if (applicationId === undefined)
      throw new ForbiddenException("An application context is required");
    const localizedQuery = await this.withApplicationTimezone(applicationId, rawQuery);
    const queryInput =
      localizedQuery.metric === undefined && kind === "provider-cost"
        ? { ...localizedQuery, metric: "provider_cost" }
        : localizedQuery.metric === undefined && kind === "aiu"
          ? { ...localizedQuery, metric: "aiu" }
          : localizedQuery;
    const query = await resolveReportProperties(
      this.database,
      parseReportQuery(queryInput, new Date(), pagination, applicationId),
    );
    if (kind === "activity" && !activityMetrics.has(query.metric)) {
      throw new BadRequestException("这个指标不适用于调用分析");
    }
    if (kind === "provider-cost" && query.metric !== "provider_cost") {
      throw new BadRequestException("模型花费页面只支持模型花费指标");
    }
    if (kind === "aiu" && query.metric !== "aiu") {
      throw new BadRequestException("AIU 页面只支持 AIU 用量指标");
    }
    const range = {
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      timezone: query.timezone,
    };
    const dependencies = await this.health.assertReady();
    const [rawData, evidence, outputPolicy] = await Promise.all([
      this.analyticsData(kind, query, dependencies),
      this.analytics.watermark(query),
      kind === "usage" ? loadUsageOutputPolicy(this.database, applicationId) : null,
    ]);
    const data =
      kind === "usage" && outputPolicy !== null
        ? maskUsagePage(
            rawData as Awaited<ReturnType<AnalyticsReportRepository["usage"]>>,
            outputPolicy,
          )
        : rawData;
    return reportEnvelopeSchema.parse({
      watermark: evidence.watermark,
      lag_seconds: evidence.lag_seconds,
      range,
      data,
    });
  }

  public async exportUsage(rawQuery: Readonly<Record<string, unknown>>): Promise<Readable> {
    if (rawQuery.cursor !== undefined) {
      throw new BadRequestException("导出会从第一条匹配记录开始，不接受分页位置");
    }
    const applicationId = this.context.current().applicationId;
    if (applicationId === undefined) {
      throw new ForbiddenException("An application context is required");
    }
    const localizedQuery = await this.withApplicationTimezone(applicationId, rawQuery);
    const parsed = await resolveReportProperties(
      this.database,
      parseReportQuery(localizedQuery, new Date(), "usage", applicationId),
    );
    const query: ReportQuery = { ...parsed, pageSize: 200, usageCursor: null };
    await this.health.assertReady();
    const policy = await loadUsageOutputPolicy(this.database, applicationId);
    const firstPage = await this.analytics.usage(query);
    const expectedTotal = firstPage.total;
    if (expectedTotal > MAX_EXPORT_ROWS) {
      throw new PayloadTooLargeException(
        `筛选结果超过 ${MAX_EXPORT_ROWS.toLocaleString("zh-CN")} 条，请缩小时间范围或增加筛选条件`,
      );
    }
    const analytics = this.analytics;
    async function* rows(): AsyncGenerator<string> {
      yield usageCsvHeader(policy);
      let exportedRows = 0;
      let cursor: string | null = null;
      let page = firstPage;
      for (;;) {
        exportedRows += page.items.length;
        if (exportedRows > MAX_EXPORT_ROWS) {
          throw new PayloadTooLargeException(
            `筛选结果超过 ${MAX_EXPORT_ROWS.toLocaleString("zh-CN")} 条，请缩小时间范围或增加筛选条件`,
          );
        }
        yield usageItemsToCsvRows(
          page.items.map((item) => maskUsageItem(item, policy)),
          policy,
        );
        if (page.next_cursor === null) return;
        if (page.next_cursor === cursor) {
          throw new ServiceUnavailableException("导出暂时无法继续，请稍后重试");
        }
        cursor = page.next_cursor;
        page = await analytics.usage({
          ...query,
          usageCursor: decodeUsageCursor(cursor),
          knownUsageTotal: expectedTotal,
        });
      }
    }
    return Readable.from(rows());
  }

  private async withApplicationTimezone(
    applicationId: string,
    rawQuery: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (rawQuery.timezone !== undefined) return rawQuery;
    const application = await this.database.application.findUnique({
      where: { id: applicationId },
      select: { timezone: true },
    });
    if (application === null) throw new ForbiddenException("Application not found");
    return { ...rawQuery, timezone: application.timezone };
  }

  private analyticsData(
    kind: ReportKind,
    query: ReportQuery,
    dependencies: Readonly<{ postgres: "healthy"; redis: "healthy"; clickhouse: "healthy" }>,
  ): Promise<unknown> {
    if (kind === "overview") return this.analytics.overview(query);
    if (kind === "usage") return this.analytics.usage(query);
    if (kind === "activity") return this.analytics.activity(query);
    if (kind === "provider-cost") return this.analytics.providerCost(query);
    if (kind === "aiu") return this.analytics.aiu(query);
    if (kind === "cache") return this.analytics.cache(query);
    if (kind === "fallback") return this.analytics.fallback(query);
    if (kind === "dimensions") return this.analytics.dimensions(query);
    return this.analytics.pipelineHealth(query, dependencies);
  }
}

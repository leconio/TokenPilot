import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "@tokenpilot/db";

import type { HealthService } from "../../src/health.controller.js";
import type { AuditContextService } from "../../src/audit-context.js";
import type { AnalyticsReportRepository } from "../../src/reports/analytics-repository.js";
import { ReportsService } from "../../src/reports/reports.service.js";

const range = {
  from: "2028-01-01T00:00:00.000Z",
  to: "2028-01-02T00:00:00.000Z",
};
const context = {
  current: () => ({
    actorId: "user:test",
    applicationId: "00000000-0000-4000-8000-000000000001",
    applicationSlug: "test",
  }),
} as unknown as AuditContextService;
const database = {
  application: { findUnique: vi.fn().mockResolvedValue({ timezone: "Asia/Shanghai" }) },
  propertyDefinition: { findMany: vi.fn().mockResolvedValue([]) },
} as unknown as DatabaseClient;

function analyticsRepository(): AnalyticsReportRepository {
  return {
    overview: vi.fn().mockResolvedValue({
      provider_cost: null,
      provider_costs: [],
      requests: 0,
      attempts: 0,
      success: 0,
      errors: 0,
      unpriced_events: 0,
      unmapped_events: 0,
      aiu: null,
      settlement_lag_seconds: null,
      reconciliation_status: null,
      last_usage_received_at: null,
    }),
    watermark: vi.fn().mockResolvedValue({
      watermark: "2028-01-01T23:59:59.000Z",
      lag_seconds: 1,
    }),
  } as unknown as AnalyticsReportRepository;
}

function health(ready = true): HealthService {
  return {
    assertReady: ready
      ? vi.fn().mockResolvedValue({
          postgres: "healthy",
          redis: "healthy",
          clickhouse: "healthy",
        })
      : vi.fn().mockRejectedValue(new ServiceUnavailableException()),
  } as unknown as HealthService;
}

describe("single analytics report path", () => {
  it("returns the compact ClickHouse envelope after mandatory datastore readiness", async () => {
    const analytics = analyticsRepository();
    const required = health();
    const service = new ReportsService(analytics, required, context, database);

    await expect(service.report("overview", range)).resolves.toMatchObject({
      watermark: "2028-01-01T23:59:59.000Z",
      lag_seconds: 1,
      data: { aiu: null, requests: 0 },
    });
    const result = await service.report("overview", range);
    expect(result).not.toHaveProperty("source");
    expect(result).not.toHaveProperty("is_provisional");
    expect(result).not.toHaveProperty("as_of");
    expect(required.assertReady).toHaveBeenCalled();
    expect(analytics.overview).toHaveBeenCalled();
    expect(analytics.overview).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "Asia/Shanghai" }),
    );
  });

  it("rejects every retired source selector before querying analytics", async () => {
    const analytics = analyticsRepository();
    const required = health();
    const service = new ReportsService(analytics, required, context, database);

    await expect(service.report("overview", { ...range, source: "official" })).rejects.toThrow(
      /Unsupported report filter source/u,
    );
    expect(required.assertReady).not.toHaveBeenCalled();
    expect(analytics.overview).not.toHaveBeenCalled();
  });

  it("does not query ClickHouse when a mandatory datastore is unavailable", async () => {
    const analytics = analyticsRepository();
    const service = new ReportsService(analytics, health(false), context, database);

    await expect(service.report("overview", range)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(analytics.overview).not.toHaveBeenCalled();
    expect(analytics.watermark).not.toHaveBeenCalled();
  });
});

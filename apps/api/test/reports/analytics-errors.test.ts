import { GatewayTimeoutException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { ClickHouseClient } from "@tokenpilot/clickhouse";

import { AnalyticsReportRepository } from "../../src/reports/analytics-repository.js";
import { parseReportQuery } from "../../src/reports/query.js";

const query = parseReportQuery({
  from: "2028-01-01T00:00:00.000Z",
  to: "2028-01-02T00:00:00.000Z",
});

describe("analytics business errors", () => {
  it("reports a query timeout separately from a temporary service failure", async () => {
    const clickhouse = {
      query: vi.fn().mockRejectedValue(new Error("TIMEOUT_EXCEEDED")),
    } as unknown as ClickHouseClient;

    await expect(new AnalyticsReportRepository(clickhouse).watermark(query)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });

  it("does not expose datastore diagnostics for other failures", async () => {
    const clickhouse = {
      query: vi.fn().mockRejectedValue(new Error("connection failed at internal-host")),
    } as unknown as ClickHouseClient;

    await expect(new AnalyticsReportRepository(clickhouse).watermark(query)).rejects.toMatchObject({
      status: 503,
      message: "统计服务暂时不可用，请稍后重试",
    });
  });
});

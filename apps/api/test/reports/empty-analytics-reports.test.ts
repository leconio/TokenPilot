import { describe, expect, it } from "vitest";

import {
  queryAnalyticsOverview,
  queryAnalyticsPipelineHealth,
} from "../../src/reports/analytics-report-data.js";
import type { ClickHouseExecute } from "../../src/reports/clickhouse-query.js";
import { parseReportQuery } from "../../src/reports/query.js";

describe("empty analytics reports", () => {
  it("returns null timestamps instead of ClickHouse epoch defaults", async () => {
    const statements: string[] = [];
    const execute: ClickHouseExecute = async (statement) => {
      const sql = statement("1 = 1");
      statements.push(sql);
      if (sql.includes("last_usage_received_at")) {
        return [
          {
            requests: "0",
            attempts: "0",
            success: "0",
            errors: "0",
            event_count: "0",
            unmapped_events: "0",
            last_usage_received_at: null,
          },
        ];
      }
      if (sql.includes("priced_events")) return [{ priced_events: "0", aiu_rated_count: "0" }];
      return [];
    };
    const query = parseReportQuery(
      { from: "2028-01-01T00:00:00.000Z", to: "2028-01-02T00:00:00.000Z" },
      new Date("2028-01-03T00:00:00.000Z"),
    );

    await expect(queryAnalyticsOverview(execute, query)).resolves.toMatchObject({
      last_usage_received_at: null,
      provider_cost: null,
      aiu: null,
    });
    expect(statements.find((sql) => sql.includes("last_usage_received_at"))).toContain(
      "if(count() = 0, NULL, toString(max(event.event_time)))",
    );

    const healthStatements: string[] = [];
    const health = await queryAnalyticsPipelineHealth(
      async (statement) => {
        const sql = statement("1 = 1");
        healthStatements.push(sql);
        return [{ event_count: "0", last_event_at: null, last_inserted_at: null }];
      },
      { postgres: "healthy", redis: "healthy", clickhouse: "healthy" },
    );
    expect(health).toMatchObject({ last_event_at: null, last_inserted_at: null });
    expect(healthStatements[0]).toContain(
      "if(count() = 0, NULL, toString(max(event.inserted_at)))",
    );
  });
});

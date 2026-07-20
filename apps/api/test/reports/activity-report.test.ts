import { describe, expect, it } from "vitest";

import { queryAnalyticsActivity } from "../../src/reports/analytics-activity.js";
import type { ClickHouseExecute } from "../../src/reports/clickhouse-query.js";
import { decodeGroupCursor, parseReportQuery } from "../../src/reports/query.js";

const range = {
  from: "2028-01-01T00:00:00.000Z",
  to: "2028-01-02T00:00:00.000Z",
};

describe("activity metric reports", () => {
  it("returns a grouped Token total, trend, and an opaque group cursor", async () => {
    const statements: string[] = [];
    let call = 0;
    const execute: ClickHouseExecute = async (statement) => {
      const sql = statement("event.application_id = {application_id:String}");
      statements.push(sql);
      call += 1;
      if (call === 1) return [{ metric_value: "30" }];
      if (call === 2) {
        return [
          { group_key: "company/chat", metric_value: "20" },
          { group_key: "company/fast", metric_value: "10" },
        ];
      }
      if (call === 3) return [{ total_groups: "3" }];
      return [
        { bucket: "2028-01-01T00:00:00.000Z", metric_value: "12" },
        { bucket: "2028-01-01T01:00:00.000Z", metric_value: "18" },
      ];
    };
    const query = parseReportQuery(
      { ...range, metric: "tokens", group_dimension: "request_model", page_size: "2" },
      new Date("2028-01-03T00:00:00.000Z"),
      "activity",
      "application-a",
    );

    const result = await queryAnalyticsActivity(execute, query);

    expect(result).toMatchObject({
      metric: "tokens",
      unit: "tokens",
      total: "30",
      total_groups: 3,
      groups: [
        { key: "company/chat", value: "20" },
        { key: "company/fast", value: "10" },
      ],
    });
    expect(result.trend).toHaveLength(2);
    expect(result.next_cursor).not.toBeNull();
    expect(decodeGroupCursor(result.next_cursor!, "activity", "request_model")).toMatchObject({
      groupKey: "company/fast",
      position: 2,
    });
    expect(statements.every((sql) => sql.includes("application_id"))).toBe(true);
    expect(statements.some((sql) => sql.includes("current_usage_lines"))).toBe(true);
    expect(statements.some((sql) => sql.includes("sum(ifNull(usage.total_tokens"))).toBe(true);
  });

  it("calculates success rate from distinct successful operations across fallback attempts", async () => {
    const statements: string[] = [];
    const execute: ClickHouseExecute = async (statement) => {
      statements.push(statement("1 = 1"));
      return [];
    };
    const query = parseReportQuery(
      { ...range, metric: "success_rate" },
      new Date("2028-01-03T00:00:00.000Z"),
      "activity",
    );

    await queryAnalyticsActivity(execute, query);

    expect(statements.some((sql) => sql.includes("uniqExactIf(event.operation_key"))).toBe(true);
    expect(
      statements.some((sql) =>
        sql.includes("if(empty(event.operation_id), event.request_id, event.operation_id)"),
      ),
    ).toBe(true);
    expect(statements.every((sql) => !sql.includes("current_rating_events"))).toBe(true);
  });

  it("does not count events without a user as an independent user", async () => {
    const statements: string[] = [];
    const execute: ClickHouseExecute = async (statement) => {
      statements.push(statement("1 = 1"));
      return [];
    };
    const query = parseReportQuery(
      { ...range, metric: "unique_users" },
      new Date("2028-01-03T00:00:00.000Z"),
      "activity",
    );

    await queryAnalyticsActivity(execute, query);

    expect(statements.some((sql) => sql.includes("uniqExactIf(event.user_id"))).toBe(true);
    expect(statements.some((sql) => sql.includes("notEmpty(event.user_id)"))).toBe(true);
  });

  it("expands each user tag into its own report group", async () => {
    const statements: string[] = [];
    const execute: ClickHouseExecute = async (statement) => {
      statements.push(statement("event.application_id = {application_id:String}"));
      return [];
    };
    const query = parseReportQuery(
      { ...range, group_dimension: "user_tag" },
      new Date("2028-01-03T00:00:00.000Z"),
      "activity",
      "application-a",
    );

    await queryAnalyticsActivity(execute, query);

    expect(statements.some((sql) => sql.includes("arrayJoin(if(empty(event.user_tags)"))).toBe(
      true,
    );
    expect(statements.every((sql) => sql.includes("application_id"))).toBe(true);
  });
});

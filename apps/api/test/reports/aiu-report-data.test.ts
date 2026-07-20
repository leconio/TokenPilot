import { describe, expect, it } from "vitest";

import { queryAnalyticsAiu } from "../../src/reports/analytics-aiu.js";
import { clickHouseFilters, type ClickHouseExecute } from "../../src/reports/clickhouse-query.js";
import { parseReportQuery } from "../../src/reports/query.js";

const range = {
  from: "2028-01-01T00:00:00.000Z",
  to: "2028-01-08T00:00:00.000Z",
};

describe("AIU report grouping", () => {
  it("scopes ratings, pages groups by keyset, and applies all filters with AND semantics", async () => {
    const statements: string[] = [];
    let where = "1 = 1";
    const execute: ClickHouseExecute = async (statement) => {
      const sql = statement(where);
      statements.push(sql);
      if (sql.includes("count() AS event_count")) {
        return [{ event_count: "3", unmapped_events: "1" }];
      }
      if (sql.includes("AS rated_events")) return [{ rated_events: "2" }];
      if (sql.includes("SELECT count() AS total FROM (")) return [{ total: "6" }];
      if (sql.includes("SELECT group_key, aiu_micros")) {
        return [{ group_key: "2028-01-02T00:00:00.000Z", aiu_micros: "3200000" }];
      }
      if (sql.includes("SELECT toString(sum(")) return [{ aiu_micros: "3200000" }];
      throw new Error(`Unexpected SQL: ${sql}`);
    };
    const query = parseReportQuery(
      {
        ...range,
        group_dimension: "day",
        page_size: "25",
        conditions: [
          { kind: "builtin", field: "aiu_status", operator: "equals", values: ["official"] },
          { kind: "builtin", field: "cost_status", operator: "equals", values: ["official"] },
        ],
      },
      new Date(),
      "aiu",
    );
    where = clickHouseFilters(query).sql;

    const result = await queryAnalyticsAiu(execute, query);

    expect(result).toMatchObject({
      total: { micros: "3200000" },
      unrated_events: 1,
      unmapped_events: 1,
      group_dimension: "day",
      groups: [
        {
          dimension: "day",
          key: "2028-01-02T00:00:00.000Z",
          aiu_micros: "3200000",
        },
      ],
      page_size: 25,
      total_groups: 6,
      next_cursor: expect.any(String),
    });
    expect(result).not.toHaveProperty("page");
    expect(statements).toHaveLength(5);
    for (const statement of statements) {
      expect(statement).toContain("rating_kind = 'provider_cost'");
      expect(statement).toContain("rating_kind = 'aiu'");
      expect(statement).toContain(" AND ");
      expect(statement).not.toContain("instance_id");
    }
    const grouped = statements.find((statement) =>
      statement.includes("SELECT group_key, aiu_micros"),
    )!;
    expect(grouped).toContain(
      "toStartOfInterval(event.event_time, INTERVAL 1 DAY, {timezone:String})",
    );
    expect(grouped).toContain("'%Y-%m-%dT%H:%i:%S.000Z'");
    expect(grouped).toContain("WITH\n        filtered_events AS");
    expect(grouped).toContain("ORDER BY group_key");
    expect(grouped).toContain("LIMIT 25");
    expect(grouped).not.toContain("OFFSET");

    const next = parseReportQuery(
      { ...range, group_dimension: "day", page_size: "25", cursor: result.next_cursor! },
      new Date(),
      "aiu",
    );
    expect(next.groupCursor).toEqual({
      kind: "aiu",
      dimension: "day",
      groupKey: "2028-01-02T00:00:00.000Z",
      secondaryKey: "",
      position: 1,
    });
    expect(clickHouseFilters(next).params).toMatchObject({
      cursor_group_key: "2028-01-02T00:00:00.000Z",
      cursor_secondary_key: "",
    });
  });

  it.each([
    ["hour", "HOUR"],
    ["day", "DAY"],
    ["week", "WEEK"],
    ["month", "MONTH"],
  ] as const)("uses the requested %s ClickHouse time bucket", async (dimension, interval) => {
    const statements: string[] = [];
    const execute: ClickHouseExecute = async (statement) => {
      const sql = statement("1 = 1");
      statements.push(sql);
      if (sql.includes("count() AS event_count")) {
        return [{ event_count: "0", unmapped_events: "0" }];
      }
      if (sql.includes("AS rated_events")) return [{ rated_events: "0" }];
      if (sql.includes("SELECT count() AS total FROM (")) return [{ total: "0" }];
      return [];
    };

    await queryAnalyticsAiu(
      execute,
      parseReportQuery({ ...range, group_dimension: dimension }, new Date(), "aiu"),
    );

    const grouped = statements.find((statement) =>
      statement.includes("SELECT group_key, aiu_micros"),
    )!;
    expect(grouped).toContain(
      `toStartOfInterval(event.event_time, INTERVAL 1 ${interval}, {timezone:String})`,
    );
    expect(grouped).toContain("current_usage_agg_1m");
    expect(grouped).not.toContain("OFFSET");
  });
});

import { describe, expect, it } from "vitest";

import { queryAnalyticsProviderCost } from "../../src/reports/analytics-provider-cost.js";
import { clickHouseFilters, type ClickHouseExecute } from "../../src/reports/clickhouse-query.js";
import { parseReportQuery } from "../../src/reports/query.js";

const range = {
  from: "2028-01-01T00:00:00.000Z",
  to: "2028-01-08T00:00:00.000Z",
};

describe("grouped report scalability", () => {
  it("uses minute aggregates and a stable Provider Cost keyset", async () => {
    const statements: string[] = [];
    const query = parseReportQuery(
      {
        ...range,
        conditions: [
          { kind: "builtin", field: "model_tag", operator: "equals", values: ["provider/model"] },
        ],
        group_dimension: "provider",
        page_size: "1",
      },
      new Date(),
      "provider_cost",
    );
    const where = clickHouseFilters(query).sql;
    const execute: ClickHouseExecute = async (statement) => {
      const sql = statement(where);
      statements.push(sql);
      if (sql.includes("failed_attempt_cost")) {
        return [{ currency: "USD", amount: "10", failed_attempt_cost: "2" }];
      }
      if (sql.includes("AND notEmpty(event.fallback_from)")) {
        return [{ currency: "USD", amount: "1" }];
      }
      if (sql.includes("SELECT count() AS total FROM (")) return [{ total: "2" }];
      if (sql.includes("SELECT group_key, currency, amount")) {
        return [{ group_key: "anthropic", currency: "USD", amount: "6" }];
      }
      if (sql.includes(") AS count")) return [{ count: "1" }];
      throw new Error(`Unexpected SQL: ${sql}`);
    };

    const result = await queryAnalyticsProviderCost(execute, query);

    expect(result).toMatchObject({
      total: { value: "10", currency: "USD" },
      totals: [{ value: "10", currency: "USD" }],
      failed_attempt_cost: { value: "2", currency: "USD" },
      fallback_extra_cost: { value: "1", currency: "USD" },
      unpriced_events: 1,
      group_dimension: "provider",
      groups: [{ dimension: "provider", key: "anthropic", currency: "USD", amount: "6" }],
      page_size: 1,
      total_groups: 2,
      next_cursor: expect.any(String),
    });
    expect(result).not.toHaveProperty("page");

    const grouped = statements.find((statement) =>
      statement.includes("SELECT group_key, currency, amount"),
    )!;
    expect(grouped).toContain("current_usage_agg_1m");
    expect(grouped).toContain("ORDER BY group_key, currency");
    expect(grouped).toContain("LIMIT 1");
    expect(grouped).not.toMatch(/\bJOIN\b/u);
    expect(grouped).not.toContain("OFFSET");

    const totals = statements.find((statement) => statement.includes("failed_attempt_cost"))!;
    expect(totals).toContain("event.status != 'success'");
    expect(totals).toContain("current_usage_agg_1m");

    const unpriced = statements.find((statement) => statement.includes(") AS count"))!;
    expect(unpriced).toContain("current_usage_events_raw");
    expect(unpriced).toContain("current_rating_events");
    expect(unpriced).not.toMatch(/\bJOIN\b/u);
    expect(unpriced).not.toContain("source_event_id IN");
    expect(unpriced).toContain("toInt64");

    const fallback = statements.find((statement) =>
      statement.includes("AND notEmpty(event.fallback_from)"),
    )!;
    expect(fallback.indexOf("filtered_events AS")).toBeLessThan(
      fallback.indexOf("INNER JOIN current_rating_events"),
    );

    const next = parseReportQuery(
      {
        ...range,
        group_dimension: "provider",
        page_size: "1",
        cursor: result.next_cursor!,
      },
      new Date(),
      "provider_cost",
    );
    expect(next.groupCursor).toEqual({
      kind: "provider_cost",
      dimension: "provider",
      groupKey: "anthropic",
      secondaryKey: "USD",
      position: 1,
    });
    expect(clickHouseFilters(next).params).toMatchObject({
      cursor_group_key: "anthropic",
      cursor_secondary_key: "USD",
    });
  });

  it("rejects cursor reuse across report kinds or grouping dimensions", async () => {
    const query = parseReportQuery(
      { ...range, group_dimension: "provider", page_size: "1" },
      new Date(),
      "provider_cost",
    );
    const execute: ClickHouseExecute = async (statement) => {
      const sql = statement("1 = 1");
      if (sql.includes("failed_attempt_cost")) {
        return [{ currency: "USD", amount: "1", failed_attempt_cost: "0" }];
      }
      if (sql.includes("SELECT count() AS total FROM (")) return [{ total: "2" }];
      if (sql.includes("SELECT group_key, currency, amount")) {
        return [{ group_key: "openai", currency: "USD", amount: "1" }];
      }
      if (sql.includes(") AS count")) return [{ count: "0" }];
      return [];
    };
    const cursor = (await queryAnalyticsProviderCost(execute, query)).next_cursor!;

    expect(() =>
      parseReportQuery({ ...range, group_dimension: "provider", cursor }, new Date(), "aiu"),
    ).toThrow(/Invalid report cursor/u);
    expect(() =>
      parseReportQuery(
        { ...range, group_dimension: "virtual_model", cursor },
        new Date(),
        "provider_cost",
      ),
    ).toThrow(/Invalid report cursor/u);
    expect(() => parseReportQuery({ ...range, page: "2" }, new Date(), "provider_cost")).toThrow(
      /Unsupported report filter page/u,
    );
  });
});

import { describe, expect, it } from "vitest";

import { queryAnalyticsOverview } from "../../src/reports/analytics-report-data.js";
import { queryAnalyticsUsage } from "../../src/reports/analytics-usage.js";
import { clickHouseFilters, type ClickHouseExecute } from "../../src/reports/clickhouse-query.js";
import { decodeGroupCursor, encodeGroupCursor, parseReportQuery } from "../../src/reports/query.js";

const range = {
  from: "2028-01-01T00:00:00.000Z",
  to: "2028-01-08T00:00:00.000Z",
};

function usageRow(eventId: string, eventTime: string) {
  return {
    event_id: eventId,
    request_id: `request-${eventId}`,
    attempt_id: `attempt-${eventId}`,
    operation_id: "",
    event_time: eventTime,
    received_at: eventTime,
    schema_version: "2.0",
    application_version: "1.0.0",
    sdk_version: "0.2.0",
    connector_version: "0.2.0",
    config_version: "42",
    user_id: "user-1",
    display_user: "Ada",
    session_id: "session-1",
    conversation_id: "conversation-1",
    trace_id: "trace-1",
    virtual_model: "text.fast",
    model_id: "model-1",
    request_model: "provider/model",
    provider: "provider",
    status: "success",
    route_reason: "primary",
    fallback_from: "",
    latency_ms: "10",
    provider_cost_status: "official",
    provider_cost_amount: "0.01",
    provider_cost_currency: "USD",
    aiu_status: "official",
    aiu_micros: "10",
    aiu_chargeable: null,
    quota_status: "allowed",
    event_text_properties: {},
    event_number_properties: {},
    event_boolean_properties: {},
    event_datetime_properties: {},
    event_enum_properties: {},
    event_text_list_properties: {},
    user_text_properties: {},
    user_number_properties: {},
    user_boolean_properties: {},
    user_datetime_properties: {},
    user_enum_properties: {},
    user_text_list_properties: {},
  };
}

describe("analytics query scalability", () => {
  it("pages Usage by keyset, counts raw events without ratings, and rates only page events", async () => {
    const statements: string[] = [];
    const query = parseReportQuery({ ...range, page_size: "2" }, new Date(), "usage");
    const where = clickHouseFilters(query).sql;
    const execute: ClickHouseExecute = async (statement) => {
      const sql = statement(where);
      statements.push(sql);
      if (sql.includes("SELECT count() AS total")) return [{ total: "3" }];
      return [
        usageRow("event-3", "2028-01-02T00:00:03.000Z"),
        usageRow("event-2", "2028-01-02T00:00:02.000Z"),
      ];
    };

    const result = await queryAnalyticsUsage(execute, query);

    expect(result).toMatchObject({ page_size: 2, total: 3 });
    expect(result.items.map((item) => item.event_id)).toEqual(["event-3", "event-2"]);
    expect(result.next_cursor).toEqual(expect.any(String));
    expect(result).not.toHaveProperty("page");

    const pageSql = statements.find((sql) => sql.includes("WITH page_events AS"))!;
    const totalSql = statements.find((sql) => sql.includes("SELECT count() AS total"))!;
    expect(pageSql).toContain("LIMIT 2");
    expect(pageSql).toContain("event.event_id AS event_id");
    expect(pageSql).toContain("event.request_id AS request_id");
    expect(pageSql).toContain("event.event_text_properties AS event_text_properties");
    expect(pageSql).toContain("SELECT min(event_time) FROM page_events");
    expect(pageSql).toContain("SELECT event_time, event_id FROM page_events");
    expect(pageSql).toContain("tuple(rating.authority_outbox_id, rating.rating_event_id)");
    expect(pageSql).not.toContain("tuple(rating.inserted_at, rating.rating_event_id)");
    expect(pageSql).not.toContain("PREWHERE");
    expect(pageSql).not.toContain("OFFSET");
    expect(totalSql).not.toContain("current_rating_events");
    expect(totalSql).not.toMatch(/\bJOIN\b/u);

    const next = parseReportQuery(
      { ...range, cursor: result.next_cursor!, page_size: "2" },
      new Date(),
      "usage",
    );
    expect(next.usageCursor).toEqual({
      eventTime: "2028-01-02T00:00:02.000Z",
      eventId: "event-2",
      position: 2,
    });
    expect(clickHouseFilters(next).params).toMatchObject({
      cursor_event_time: "2028-01-02T00:00:02.000Z",
      cursor_event_id: "event-2",
    });
  });

  it("rejects page-number pagination and malformed cursors on Usage", () => {
    expect(() => parseReportQuery({ ...range, page: "2" }, new Date(), "usage")).toThrow(
      /Unsupported report filter page/u,
    );
    expect(() => parseReportQuery({ ...range, cursor: "invalid" }, new Date(), "usage")).toThrow(
      /Invalid report cursor/u,
    );
    expect(() => parseReportQuery({ ...range, cursor: "invalid" })).toThrow(/does not use cursor/u);
  });

  it("round-trips a Unicode custom group value through the opaque cursor", () => {
    const groupKey = "标签".repeat(512);
    const cursor = encodeGroupCursor({
      kind: "activity",
      dimension: "property:user:segment",
      groupKey,
      secondaryKey: "",
      position: 10,
    });

    expect(cursor.length).toBeGreaterThan(512);
    expect(decodeGroupCursor(cursor, "activity", "property:user:segment").groupKey).toBe(groupKey);
  });

  it("reuses the first export page total instead of recounting every cursor page", async () => {
    const statements: string[] = [];
    const parsed = parseReportQuery({ ...range, page_size: "2" }, new Date(), "usage");
    const query = { ...parsed, knownUsageTotal: 3 };
    await queryAnalyticsUsage(async (statement) => {
      statements.push(statement(clickHouseFilters(query).sql));
      return [usageRow("event-1", "2028-01-02T00:00:01.000Z")];
    }, query);

    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toContain("SELECT count() AS total");
  });

  it("uses minute aggregates for aligned overview filters without rating-to-event joins", async () => {
    const statements: string[] = [];
    const query = parseReportQuery({
      ...range,
      conditions: [
        { kind: "builtin", field: "request_model", operator: "equals", values: ["provider/model"] },
      ],
    });
    const where = clickHouseFilters(query).sql;
    const execute: ClickHouseExecute = async (statement) => {
      const sql = statement(where);
      statements.push(sql);
      if (sql.includes("uniqExact(event.request_id)")) {
        return [
          {
            requests: "3",
            attempts: "3",
            success: "2",
            errors: "1",
            event_count: "3",
            unmapped_events: "0",
            last_usage_received_at: "2028-01-02T00:00:03.000Z",
          },
        ];
      }
      if (sql.includes("AS priced_events")) {
        return [{ priced_events: "2", aiu_rated_count: "2" }];
      }
      if (sql.includes("AS currency")) return [{ currency: "USD", amount: "1.25" }];
      return [{ aiu_micros: "25" }];
    };

    await expect(queryAnalyticsOverview(execute, query)).resolves.toMatchObject({
      requests: 3,
      unpriced_events: 1,
      provider_cost: { value: "1.25", currency: "USD" },
      aiu: { micros: "25" },
    });

    const summary = statements.find((sql) => sql.includes("uniqExact(event.request_id)"))!;
    const ratingStatements = statements.filter((sql) => sql.includes("current_rating_events"));
    const aggregateStatements = statements.filter((sql) => sql.includes("current_usage_agg_1m"));
    expect(summary).not.toContain("current_rating_events");
    expect(summary).not.toMatch(/\bJOIN\b/u);
    expect(ratingStatements).toHaveLength(1);
    expect(ratingStatements[0]).not.toMatch(/\bJOIN\b/u);
    expect(aggregateStatements).toHaveLength(2);
    expect(statements.join("\n")).not.toContain("OFFSET");
  });

  it("scopes ratings to filtered event IDs when a filter is not in minute aggregates", async () => {
    const statements: string[] = [];
    const query = parseReportQuery({
      ...range,
      conditions: [{ kind: "builtin", field: "user_id", operator: "equals", values: ["user-1"] }],
    });
    const where = clickHouseFilters(query).sql;
    const execute: ClickHouseExecute = async (statement) => {
      const sql = statement(where);
      statements.push(sql);
      if (sql.includes("uniqExact(event.request_id)")) {
        return [
          {
            requests: "0",
            attempts: "0",
            success: "0",
            errors: "0",
            event_count: "0",
            unmapped_events: "0",
          },
        ];
      }
      if (sql.includes("AS priced_events")) return [{ priced_events: "0", aiu_rated_count: "0" }];
      return [];
    };

    await queryAnalyticsOverview(execute, query);

    const ratingStatements = statements.filter((sql) => sql.includes("current_rating_events"));
    expect(ratingStatements).toHaveLength(3);
    for (const sql of ratingStatements) {
      expect(sql).toContain("filtered_events AS");
      expect(sql).toContain("rating.source_event_id IN (SELECT event_id FROM filtered_events)");
      expect(sql).not.toContain("PREWHERE");
    }
    expect(statements.join("\n")).not.toContain("current_usage_agg_1m");
  });
});

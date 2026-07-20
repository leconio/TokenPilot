import { describe, expect, it } from "vitest";

import {
  GROUP_REPORT_QUERY,
  REPORT_QUERY,
  USAGE_REPORT_QUERY,
} from "../../src/openapi/schemas/usage.js";
import { parseReportQuery } from "../../src/reports/query.js";
import { clickHouseFilters } from "../../src/reports/clickhouse-query.js";

const range = {
  from: "2028-01-01T00:00:00.000Z",
  to: "2028-01-02T00:00:00.000Z",
};

describe("report condition matching", () => {
  it("documents the match relation and typed conditions", () => {
    expect(REPORT_QUERY.find((parameter) => parameter.name === "filter_match")?.schema).toEqual({
      type: "string",
      enum: ["all", "any"],
    });
    expect(REPORT_QUERY.find((parameter) => parameter.name === "conditions")?.schema).toMatchObject(
      { type: "string", minLength: 2 },
    );
  });

  it("documents keyset pagination for Usage and grouped reports", () => {
    expect(USAGE_REPORT_QUERY.some((parameter) => parameter.name === "cursor")).toBe(true);
    expect(USAGE_REPORT_QUERY.some((parameter) => parameter.name === "page")).toBe(false);
    expect(REPORT_QUERY.some((parameter) => parameter.name === "cursor")).toBe(false);
    expect(REPORT_QUERY.some((parameter) => parameter.name === "page")).toBe(false);
    expect(GROUP_REPORT_QUERY.some((parameter) => parameter.name === "cursor")).toBe(true);
    expect(GROUP_REPORT_QUERY.some((parameter) => parameter.name === "page")).toBe(false);
  });

  it("preserves repeated filters and joins any-match atoms in ClickHouse", () => {
    const filter = clickHouseFilters(
      parseReportQuery({
        ...range,
        filter_match: "any",
        conditions: [
          {
            kind: "builtin",
            field: "request_model",
            operator: "one_of",
            values: ["model-a", "model-b"],
          },
          {
            kind: "builtin",
            field: "cost_status",
            operator: "equals",
            values: ["official"],
          },
        ],
      }),
    );

    expect(filter.sql).toContain(" OR ");
    expect(filter.sql).toContain("rating_kind = 'provider_cost'");
    expect(filter.sql).toContain("argMax(status");
    expect(filter.sql).toContain("authority_outbox_id");
    expect(filter.sql).not.toContain("argMax(rating_stage");
    expect(filter.params).toMatchObject({
      filter_0_value_0: "model-a",
      filter_0_value_1: "model-b",
      filter_1_value_0: "official",
    });
    expect(filter.sql).not.toContain("instance_id");
    expect(filter.params).not.toHaveProperty("instance_id");
  });

  it("rejects the removed report source selector", () => {
    expect(() => parseReportQuery({ ...range, source: "official" })).toThrow(
      /Unsupported report filter source/u,
    );
    expect(REPORT_QUERY.some((parameter) => parameter.name === "source")).toBe(false);
  });

  it("treats repeated values of one field as a set while combining different fields", () => {
    const filter = clickHouseFilters(
      parseReportQuery({
        ...range,
        conditions: [
          {
            kind: "builtin",
            field: "request_model",
            operator: "one_of",
            values: ["model-a", "model-b"],
          },
          {
            kind: "builtin",
            field: "provider",
            operator: "equals",
            values: ["openai"],
          },
        ],
      }),
    );

    const first = filter.sql.indexOf("filter_0_value_0:String");
    const second = filter.sql.indexOf("filter_0_value_1:String");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(filter.sql.slice(first, second)).toContain(" OR ");
    expect(filter.sql.slice(second)).toContain(" AND ");
  });

  it("filters and groups every execution path by its call connection", () => {
    const filter = clickHouseFilters(
      parseReportQuery({
        ...range,
        group_dimension: "connection_id",
        conditions: [
          {
            kind: "builtin",
            field: "connection_driver",
            operator: "one_of",
            values: ["litellm", "anthropic"],
          },
        ],
      }),
    );

    expect(filter.sql).toContain("event.connection_driver");
    expect(filter.params).toMatchObject({
      filter_0_value_0: "litellm",
      filter_0_value_1: "anthropic",
    });
  });

  it("rejects operators and values that do not match built-in field types", () => {
    expect(() =>
      parseReportQuery({
        ...range,
        conditions: [
          {
            kind: "builtin",
            field: "event_id",
            operator: "greater_than",
            values: [10],
          },
        ],
      }),
    ).toThrow(/not valid|does not match/u);
    expect(() =>
      parseReportQuery({
        ...range,
        conditions: [
          {
            kind: "builtin",
            field: "event_id",
            operator: "contains",
            values: ["partial"],
          },
        ],
      }),
    ).toThrow(/not valid/u);
    expect(() =>
      parseReportQuery({
        ...range,
        conditions: [
          {
            kind: "builtin",
            field: "latency_ms",
            operator: "between",
            values: [200, 100],
          },
        ],
      }),
    ).toThrow(/beginning of a range/u);
  });

  it("finds events without an AIU result without requiring a rating row", () => {
    const filter = clickHouseFilters(
      parseReportQuery({
        ...range,
        conditions: [{ kind: "builtin", field: "aiu_status", operator: "is_not_set", values: [] }],
      }),
    );

    expect(filter.sql).toContain("event.event_id NOT IN");
    expect(filter.sql).toContain("notEmpty(toString(rating_status))");
  });
});

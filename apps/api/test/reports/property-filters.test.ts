import { describe, expect, it, vi } from "vitest";

import type { DatabaseClient } from "@tokenpilot/db";

import { clickHouseFilters } from "../../src/reports/clickhouse-query.js";
import { groupQueryPlan } from "../../src/reports/analytics-group-query.js";
import { resolveReportProperties } from "../../src/reports/property-resolution.js";
import { parseReportQuery } from "../../src/reports/query.js";

const range = {
  from: "2028-01-01T00:00:00.000Z",
  to: "2028-01-02T00:00:00.000Z",
};

function database(definitions: readonly object[]): DatabaseClient {
  return {
    propertyDefinition: { findMany: vi.fn().mockResolvedValue(definitions) },
  } as unknown as DatabaseClient;
}

describe("typed report property filters", () => {
  it("filters and groups user tags from ClickHouse event facts", () => {
    const query = parseReportQuery({
      ...range,
      group_dimension: "user_tag",
      conditions: [
        { kind: "builtin", field: "user_tag", operator: "one_of", values: ["paid", "beta"] },
      ],
    });
    const compiled = clickHouseFilters(query);
    expect(compiled.sql).toContain("has(event.user_tags, {filter_0_value_0:String})");
    expect(compiled.sql).toContain("has(event.user_tags, {filter_0_value_1:String})");
    expect(compiled.params).toMatchObject({
      filter_0_value_0: "paid",
      filter_0_value_1: "beta",
    });
    expect(groupQueryPlan(query).group).toBe(
      "arrayJoin(if(empty(event.user_tags), [''], event.user_tags))",
    );
    expect(groupQueryPlan(query).useMinuteAggregate).toBe(false);
  });

  it("resolves application fields and compiles typed maps with bound values", async () => {
    const query = parseReportQuery({
      ...range,
      conditions: [
        {
          kind: "property",
          scope: "event",
          key: "latency_score",
          operator: "between",
          values: [10, 20],
        },
        {
          kind: "property",
          scope: "user",
          key: "interests",
          operator: "contains_all",
          values: ["AI", "voice"],
        },
      ],
    });
    const resolved = await resolveReportProperties(
      database([
        {
          key: "latency_score",
          scope: "EVENT",
          dataType: "NUMBER",
          searchable: true,
        },
        { key: "interests", scope: "USER", dataType: "TEXT_LIST", searchable: true },
      ]),
      query,
    );
    const compiled = clickHouseFilters(resolved);

    expect(compiled.sql).toContain("event.event_number_properties");
    expect(compiled.sql).toContain("event.user_text_list_properties");
    expect(compiled.sql).toContain("has(event.user_text_list_properties");
    expect(compiled.sql).toContain(" AND ");
    expect(compiled.sql).not.toContain("latency_score");
    expect(compiled.sql).not.toContain("voice");
    expect(compiled.params).toMatchObject({
      filter_0_key: "latency_score",
      filter_0_value_0: 10,
      filter_0_value_1: 20,
      filter_1_key: "interests",
      filter_1_value_0: "AI",
      filter_1_value_1: "voice",
    });
  });

  it("rejects missing, non-searchable, mismatched, and invalid comparisons", async () => {
    const base = parseReportQuery({
      ...range,
      conditions: [
        {
          kind: "property",
          scope: "event",
          key: "voice_enabled",
          operator: "contains",
          values: ["yes"],
        },
      ],
    });
    await expect(resolveReportProperties(database([]), base)).rejects.toThrow(/not available/u);
    await expect(
      resolveReportProperties(
        database([
          {
            key: "voice_enabled",
            scope: "EVENT",
            dataType: "BOOLEAN",
            searchable: true,
          },
        ]),
        base,
      ),
    ).rejects.toThrow(/comparison/u);
  });

  it("never accepts a sensitive application field as a report filter", async () => {
    const parsed = parseReportQuery({
      ...range,
      conditions: [
        {
          kind: "property",
          scope: "user",
          key: "private_note",
          operator: "equals",
          values: ["secret"],
        },
      ],
    });

    await expect(
      resolveReportProperties(
        database([
          {
            key: "private_note",
            scope: "USER",
            dataType: "TEXT",
            searchable: true,
            groupable: false,
            sensitive: true,
          },
        ]),
        parsed,
      ),
    ).rejects.toThrow(/not available for search/u);
  });

  it("rejects a reversed typed custom-field range", async () => {
    const parsed = parseReportQuery({
      ...range,
      conditions: [
        {
          kind: "property",
          scope: "event",
          key: "happened_at",
          operator: "between",
          values: ["2028-01-02T00:00:00.000Z", "2028-01-01T00:00:00.000Z"],
        },
      ],
    });

    await expect(
      resolveReportProperties(
        database([
          {
            key: "happened_at",
            scope: "EVENT",
            dataType: "DATETIME",
            searchable: true,
            groupable: false,
            sensitive: false,
          },
        ]),
        parsed,
      ),
    ).rejects.toThrow(/范围起点/u);
  });

  it("rejects impossible or non-UTC custom-field timestamps", async () => {
    const definition = {
      key: "happened_at",
      scope: "EVENT",
      dataType: "DATETIME",
      searchable: true,
      groupable: false,
      sensitive: false,
    };
    for (const value of ["2028-02-30T00:00:00.000Z", "2028-02-01T08:00:00+08:00"]) {
      const parsed = parseReportQuery({
        ...range,
        conditions: [
          {
            kind: "property",
            scope: "event",
            key: "happened_at",
            operator: "equals",
            values: [value],
          },
        ],
      });
      await expect(resolveReportProperties(database([definition]), parsed)).rejects.toThrow(
        /does not match/u,
      );
    }
  });

  it("groups by an application field only when that field is marked groupable", async () => {
    const parsed = parseReportQuery({
      ...range,
      group_dimension: "property",
      group_property: JSON.stringify({ scope: "user", key: "plan" }),
    });
    const resolved = await resolveReportProperties(
      database([
        {
          key: "plan",
          scope: "USER",
          dataType: "ENUM",
          searchable: true,
          groupable: true,
        },
      ]),
      parsed,
    );
    expect(groupQueryPlan(resolved).group).toBe(
      "toString(event.user_enum_properties[{group_property_key:String}])",
    );
    expect(clickHouseFilters(resolved).params.group_property_key).toBe("plan");

    await expect(
      resolveReportProperties(
        database([
          {
            key: "plan",
            scope: "USER",
            dataType: "ENUM",
            searchable: true,
            groupable: false,
          },
        ]),
        parsed,
      ),
    ).rejects.toThrow(/not available for grouping/u);
  });

  it("never exposes a sensitive application field through grouping", async () => {
    const parsed = parseReportQuery({
      ...range,
      group_dimension: "property",
      group_property: JSON.stringify({ scope: "user", key: "private_segment" }),
    });

    await expect(
      resolveReportProperties(
        database([
          {
            key: "private_segment",
            scope: "USER",
            dataType: "TEXT",
            searchable: true,
            groupable: true,
            sensitive: true,
          },
        ]),
        parsed,
      ),
    ).rejects.toThrow(/not available for grouping/u);
  });

  it("rejects text-list grouping because its value cannot form a bounded cursor", async () => {
    const parsed = parseReportQuery({
      ...range,
      group_dimension: "property",
      group_property: JSON.stringify({ scope: "user", key: "interests" }),
    });

    await expect(
      resolveReportProperties(
        database([
          {
            key: "interests",
            scope: "USER",
            dataType: "TEXT_LIST",
            searchable: true,
            groupable: true,
            sensitive: false,
          },
        ]),
        parsed,
      ),
    ).rejects.toThrow(/not available for grouping/u);
  });

  it("resolves a current application user-group snapshot into a bound user filter", async () => {
    const groupId = "00000000-0000-4000-8000-000000000901";
    const parsed = parseReportQuery({
      ...range,
      conditions: [{ kind: "builtin", field: "user_group", operator: "equals", values: [groupId] }],
    });
    const scopedDatabase = {
      propertyDefinition: { findMany: vi.fn().mockResolvedValue([]) },
      applicationUserGroup: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: groupId,
            definitionVersion: 3,
            evaluations: [
              {
                definitionVersion: 3,
                members: [
                  { user: { externalId: "customer-1" } },
                  { user: { externalId: "customer-2" } },
                ],
              },
            ],
          },
        ]),
      },
    } as unknown as DatabaseClient;

    const resolved = await resolveReportProperties(scopedDatabase, parsed);
    const compiled = clickHouseFilters(resolved);

    expect(scopedDatabase.applicationUserGroup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ applicationId: parsed.applicationId }),
      }),
    );
    expect(compiled.sql).toContain("event.user_id IN {filter_0_user_ids:Array(String)}");
    expect(compiled.params.filter_0_user_ids).toEqual(["customer-1", "customer-2"]);
  });
});

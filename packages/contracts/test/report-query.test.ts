import { describe, expect, it } from "vitest";

import { reportGroupDimensionValues, reportQuerySchema } from "../src/report-query.js";

const range = {
  from: "2026-07-15T00:00:00.000Z",
  to: "2026-07-16T00:00:00.000Z",
};

describe("ReportQuery", () => {
  it("defaults canonical pagination without a selectable storage source", () => {
    expect(reportQuerySchema.parse(range)).toMatchObject({
      timezone: "UTC",
      page_size: 50,
      filter_match: "all",
      conditions: [],
      group_dimension: "request_model",
    });
  });

  it("accepts an opaque bounded Usage cursor", () => {
    expect(reportQuerySchema.parse({ ...range, cursor: "opaque_cursor" }).cursor).toBe(
      "opaque_cursor",
    );
    expect(reportQuerySchema.safeParse({ ...range, cursor: "x".repeat(16_385) }).success).toBe(
      false,
    );
  });

  it("keeps repeated values and their explicit any-match meaning", () => {
    expect(
      reportQuerySchema.parse({
        ...range,
        filter_match: "any",
        conditions: [
          {
            kind: "builtin",
            field: "request_model",
            operator: "one_of",
            values: ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-4"],
          },
        ],
      }),
    ).toMatchObject({
      filter_match: "any",
      conditions: [expect.objectContaining({ field: "request_model", operator: "one_of" })],
    });
  });

  it("accepts usage filters, dimension filters, and cost grouping", () => {
    expect(
      reportQuerySchema.parse({
        ...range,
        page_size: 25,
        conditions: [
          { kind: "builtin", field: "request_id", operator: "equals", values: ["request-1"] },
          {
            kind: "property",
            scope: "event",
            key: "team",
            operator: "equals",
            values: ["platform"],
          },
        ],
        group_dimension: "provider",
      }),
    ).toMatchObject({
      page_size: 25,
      conditions: expect.arrayContaining([
        expect.objectContaining({ kind: "builtin", field: "request_id" }),
        expect.objectContaining({ kind: "property", key: "team" }),
      ]),
      group_dimension: "provider",
    });
  });

  it("rejects removed page-number pagination", () => {
    expect(reportQuerySchema.safeParse({ ...range, page: 3 }).success).toBe(false);
  });

  it("rejects every storage source selector", () => {
    expect(reportQuerySchema.safeParse({ ...range, source: "official" }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ ...range, source: "realtime" }).success).toBe(false);
  });

  it.each(reportGroupDimensionValues.filter((value) => value !== "property"))(
    "accepts the %s report grouping",
    (groupDimension) => {
      expect(
        reportQuerySchema.parse({ ...range, group_dimension: groupDimension }).group_dimension,
      ).toBe(groupDimension);
    },
  );

  it("requires a field definition for custom grouping", () => {
    expect(
      reportQuerySchema.parse({
        ...range,
        group_dimension: "property",
        group_property: { scope: "user", key: "plan" },
      }).group_property,
    ).toEqual({ scope: "user", key: "plan" });
    expect(() => reportQuerySchema.parse({ ...range, group_dimension: "property" })).toThrow();
  });
});

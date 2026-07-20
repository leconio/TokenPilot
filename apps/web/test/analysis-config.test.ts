import { describe, expect, it } from "vitest";

import {
  analysisRange,
  analysisSelectionFromSearch,
  defaultAnalysisSelection,
  reportParameters,
  rowsToCsv,
  selectionForGroupDrill,
} from "../features/control-plane/usage/analysis-config.js";
import { query } from "../lib/api.js";
import { aiuGroupLabel, formatAiuMicros } from "../features/control-plane/aiu/aiu-group-values.js";

describe("analysis query configuration", () => {
  it("hydrates report range and filters from a shared link", () => {
    const search = new URLSearchParams({
      range: "24h",
      metric: "provider_cost",
      filter_match: "any",
      conditions: JSON.stringify([
        { kind: "builtin", field: "model_tag", operator: "equals", values: ["company/chat"] },
        { kind: "builtin", field: "provider", operator: "equals", values: ["openai"] },
        { kind: "builtin", field: "provider", operator: "equals", values: ["azure"] },
      ]),
    });

    expect(analysisSelectionFromSearch("cost", search)).toEqual({
      ...defaultAnalysisSelection("cost"),
      range: "24h",
      match: "any",
      conditions: [
        {
          id: "query-0",
          kind: "builtin",
          field: "model_tag",
          operator: "equals",
          values: ["company/chat"],
        },
        {
          id: "query-1",
          kind: "builtin",
          field: "provider",
          operator: "equals",
          values: ["openai"],
        },
        {
          id: "query-2",
          kind: "builtin",
          field: "provider",
          operator: "equals",
          values: ["azure"],
        },
      ],
    });
  });

  it("hydrates a supported usage metric and sends metric and grain to the server", () => {
    const selection = analysisSelectionFromSearch(
      "usage",
      new URLSearchParams({ metric: "tokens", range: "30d" }),
    );

    expect(selection.metric).toBe("tokens");
    expect(reportParameters({ ...selection, grain: "week" })).toMatchObject({
      metric: "tokens",
      grain: "week",
    });
  });

  it("builds an accurate server-supported all-condition query", () => {
    const selection = {
      ...defaultAnalysisSelection("cost"),
      range: "7d" as const,
      conditions: [
        {
          id: "one",
          kind: "builtin" as const,
          field: "model_tag" as const,
          operator: "equals" as const,
          values: ["openai/gpt-4.1-mini"],
        },
        {
          id: "two",
          kind: "builtin" as const,
          field: "provider" as const,
          operator: "equals" as const,
          values: ["openai"],
        },
      ],
    };
    const parameters = reportParameters(selection, new Date("2026-07-16T12:00:00.000Z"));

    expect(parameters).toMatchObject({
      from: "2026-07-09T12:00:00.000Z",
      to: "2026-07-16T12:00:00.000Z",
      filter_match: "all",
      group_dimension: "model_tag",
    });
    expect(JSON.parse(String(parameters.conditions))).toEqual([
      {
        kind: "builtin",
        field: "model_tag",
        operator: "equals",
        values: ["openai/gpt-4.1-mini"],
      },
      { kind: "builtin", field: "provider", operator: "equals", values: ["openai"] },
    ]);
  });

  it("serializes any-match and repeated model values without losing either model", () => {
    const selection = {
      ...defaultAnalysisSelection("aiu"),
      match: "any" as const,
      conditions: [
        {
          id: "one",
          kind: "builtin" as const,
          field: "model_tag" as const,
          operator: "equals" as const,
          values: ["openai/gpt-4.1-mini"],
        },
        {
          id: "two",
          kind: "builtin" as const,
          field: "model_tag" as const,
          operator: "equals" as const,
          values: ["anthropic/claude-sonnet-4"],
        },
        {
          id: "three",
          kind: "builtin" as const,
          field: "provider" as const,
          operator: "equals" as const,
          values: ["openai"],
        },
      ],
    };
    const parameters = reportParameters(selection);
    const search = new URLSearchParams(query(parameters).slice(1));

    expect(parameters).toMatchObject({
      filter_match: "any",
    });
    expect(search.get("filter_match")).toBe("any");
    expect(JSON.parse(search.get("conditions") ?? "[]")).toHaveLength(3);
  });

  it("uses the selected AIU time grain and maximum cursor page size", () => {
    const parameters = reportParameters(
      {
        ...defaultAnalysisSelection("aiu"),
        group: { kind: "builtin", dimension: "time" },
        grain: "week",
      },
      new Date("2026-07-16T12:00:00.000Z"),
      true,
      true,
      200,
    );
    expect(parameters).toMatchObject({ group_dimension: "week", page_size: 200 });
  });

  it("turns a selected group into an exact event drill-down condition", () => {
    const selection = {
      ...defaultAnalysisSelection("usage"),
      group: { kind: "builtin", dimension: "model_tag" } as const,
      conditions: [
        {
          id: "old-model",
          kind: "builtin" as const,
          field: "model_tag" as const,
          operator: "equals" as const,
          values: ["old-model"],
        },
        {
          id: "provider",
          kind: "builtin" as const,
          field: "provider" as const,
          operator: "equals" as const,
          values: ["openai"],
        },
      ],
    };

    expect(selectionForGroupDrill(selection, [], "selected-model")?.conditions).toEqual([
      selection.conditions[1],
      {
        id: "drill-model_tag",
        kind: "builtin",
        field: "model_tag",
        operator: "equals",
        values: ["selected-model"],
      },
    ]);
  });

  it("supports the full set of simple time ranges", () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    expect(analysisRange("24h", now).from).toBe("2026-07-15T12:00:00.000Z");
    expect(analysisRange("90d", now).from).toBe("2026-04-17T12:00:00.000Z");
  });

  it("exports a CSV without losing commas or quotes", () => {
    expect(rowsToCsv([{ 模型: '模型, "快速"', 花费: "1.25" }])).toBe(
      '"模型","花费"\n"模型, ""快速""","1.25"',
    );
  });

  it("neutralizes spreadsheet formulas in exported values", () => {
    expect(rowsToCsv([{ 用户: '=HYPERLINK("https://example.test")' }])).toBe(
      '"用户"\n"\'=HYPERLINK(""https://example.test"")"',
    );
  });

  it("shows a user name instead of the internal subject id", () => {
    const row = {
      dimension: "user_id",
      key: "user-42",
      aiu_micros: "3250000",
    };
    expect(
      aiuGroupLabel(
        row,
        { kind: "builtin", dimension: "user_id" },
        "day",
        new Map([[row.key, "演示用户"]]),
      ),
    ).toBe("演示用户");
    expect(formatAiuMicros(row.aiu_micros)).toBe("3.25 AIU");
  });
});

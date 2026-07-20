import { describe, expect, it } from "vitest";

import type { AiuReportData, UsagePageEnvelope } from "../src/report-data.js";

describe("AIU report data", () => {
  it("defines cursor-paged groups alongside the summary", () => {
    const report = {
      total: { micros: "4500000" },
      unrated_events: 1,
      unmapped_events: 0,
      group_dimension: "user_id",
      groups: [
        {
          dimension: "user_id",
          key: "user-1",
          aiu_micros: "4500000",
        },
      ],
      page_size: 50,
      total_groups: 1,
      next_cursor: null,
    } satisfies AiuReportData;

    expect(report.groups[0]).toEqual({
      dimension: "user_id",
      key: "user-1",
      aiu_micros: "4500000",
    });
    expect(report).not.toHaveProperty("page");
  });
});

describe("Usage report data", () => {
  it("exposes cursor pagination without a page number", () => {
    const report = {
      items: [],
      page_size: 50,
      total: 75,
      next_cursor: "opaque",
    } satisfies UsagePageEnvelope<never>;

    expect(report).not.toHaveProperty("page");
    expect(report.next_cursor).toBe("opaque");
  });
});

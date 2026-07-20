import { describe, expect, it } from "vitest";

import { reportInstant, usagePageEnvelope, usageReportItem } from "../../src/reports/data.js";

function usageRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    event_id: "event-1",
    request_id: "request-1",
    attempt_id: "attempt-1",
    event_time: "2026-07-16 00:30:00.123",
    schema_version: "2.0",
    status: "success",
    user_id: "user-1",
    request_model: "provider/model",
    latency_ms: "12",
    ...overrides,
  };
}

describe("analytics report row normalization", () => {
  it("treats ClickHouse timestamps without an offset as explicit UTC", () => {
    expect(reportInstant("2026-07-16 00:30:00.123")).toBe("2026-07-16T00:30:00.123Z");
    expect(usageReportItem(usageRow())).toMatchObject({
      event_time: "2026-07-16T00:30:00.123Z",
      latency_ms: 12,
    });
  });

  it("restores typed Boolean properties from ClickHouse UInt8 map values", () => {
    expect(
      usageReportItem(
        usageRow({
          event_boolean_properties: { enabled: 1, hidden: 0 },
          user_boolean_properties: { verified: "1", suspended: "0" },
        }),
      ),
    ).toMatchObject({
      event_properties: { enabled: true, hidden: false },
      user_properties: { verified: true, suspended: false },
    });
  });

  it("uses stable error types for invalid usage rows and totals", () => {
    expect(() => usageReportItem(usageRow({ event_time: "invalid" }))).toThrowError(
      expect.objectContaining({ name: "UsageReportTimeError" }),
    );
    expect(() => usageReportItem(usageRow({ latency_ms: "12.5" }))).toThrowError(
      expect.objectContaining({ name: "UsageReportLatencyError" }),
    );
    expect(() => usagePageEnvelope([], 50, "invalid", null)).toThrowError(
      expect.objectContaining({ name: "UsageReportTotalError" }),
    );
  });
});

import { describe, expect, it } from "vitest";

import { schedulerErrorCode, serializeSchedulerLog } from "../src/observability.js";

describe("scheduler observability", () => {
  it("emits the same fixed operational correlation fields", () => {
    const line = serializeSchedulerLog(
      {
        level: "info",
        event: "scheduler.tick.completed",
        durationMs: 4.25,
        jobs: 7,
      },
      new Date("2026-07-15T12:00:00.000Z"),
    );
    expect(JSON.parse(line)).toEqual({
      timestamp: "2026-07-15T12:00:00.000Z",
      level: "info",
      component: "scheduler",
      event: "scheduler.tick.completed",
      request_id: null,
      event_id: null,
      job_id: null,
      trace_id: null,
      error_code: null,
      duration_ms: 4.25,
      jobs: 7,
    });
  });

  it("reduces errors to bounded non-content codes", () => {
    class SchedulerFailureWithUnsafeName extends Error {
      override name = "unsafe failure / token";
    }
    expect(schedulerErrorCode(new SchedulerFailureWithUnsafeName("PROVIDER_KEY_SENTINEL"))).toBe(
      "unsafe_failure___token",
    );
  });
});

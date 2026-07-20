import { describe, expect, it } from "vitest";

import {
  scheduledReconciliationIdempotencyKey,
  scheduledReconciliationPlan,
} from "../../src/reconciliation/schedule.js";

describe("reconciliation schedules", () => {
  it("selects the previous complete UTC hour", () => {
    const plan = scheduledReconciliationPlan(
      "application-a",
      "hourly",
      new Date("2026-07-16T13:07:42.000Z"),
    );
    expect(plan.rangeStart).toBe("2026-07-16T12:00:00.000Z");
    expect(plan.rangeEnd).toBe("2026-07-16T13:00:00.000Z");
    expect(scheduledReconciliationIdempotencyKey(plan)).toBe(
      "reconciliation:application-a:hourly:2026-07-16T12:00:00.000Z:2026-07-16T13:00:00.000Z",
    );
  });

  it("selects the previous complete UTC day", () => {
    const plan = scheduledReconciliationPlan(
      "application-a",
      "daily",
      new Date("2026-07-16T01:17:00.000Z"),
    );
    expect(plan.rangeStart).toBe("2026-07-15T00:00:00.000Z");
    expect(plan.rangeEnd).toBe("2026-07-16T00:00:00.000Z");
  });
});

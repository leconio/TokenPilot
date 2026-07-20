import { describe, expect, it } from "vitest";

import { QuotaPeriodType } from "@tokenpilot/db";

import { quotaPeriodWindow } from "../../src/users/quota-period.js";

describe("application AIU quota calendar windows", () => {
  it("aligns a day to the application's local midnight", () => {
    const window = quotaPeriodWindow(
      QuotaPeriodType.CALENDAR_DAY,
      "Asia/Shanghai",
      new Date("2026-07-18T04:00:00.000Z"),
    );
    expect(window.start.toISOString()).toBe("2026-07-17T16:00:00.000Z");
    expect(window.end?.toISOString()).toBe("2026-07-18T16:00:00.000Z");
  });

  it("uses calendar boundaries across daylight-saving changes", () => {
    const window = quotaPeriodWindow(
      QuotaPeriodType.CALENDAR_DAY,
      "America/New_York",
      new Date("2026-03-08T16:00:00.000Z"),
    );
    expect(window.start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(window.end?.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("starts a calendar week on Monday in the application timezone", () => {
    const window = quotaPeriodWindow(
      QuotaPeriodType.CALENDAR_WEEK,
      "UTC",
      new Date("2026-07-18T12:00:00.000Z"),
    );
    expect(window.start.toISOString()).toBe("2026-07-13T00:00:00.000Z");
    expect(window.end?.toISOString()).toBe("2026-07-20T00:00:00.000Z");
  });
});

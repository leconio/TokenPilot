import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  fullDateTime,
  instantAtInstanceHour,
  instanceLocalDateTimeToUtc,
  utcToInstanceDateTimeLocal,
} from "../../apps/web/lib/time.js";

const originalBrowserTimezone = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "UTC";
});

afterAll(() => {
  if (originalBrowserTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalBrowserTimezone;
});

describe("instance timezone presentation and simulation", () => {
  const reference = new Date("2026-07-15T12:30:00.000Z");

  it("turns the instance's local clock hour into the correct UTC instant", () => {
    expect(instantAtInstanceHour("Asia/Shanghai", 10, reference)).toBe("2026-07-15T02:00:00.000Z");
    expect(instantAtInstanceHour("Asia/Shanghai", 2, reference)).toBe("2026-07-14T18:00:00.000Z");
    expect(instantAtInstanceHour("America/New_York", 10, reference)).toBe(
      "2026-07-15T14:00:00.000Z",
    );
  });

  it("formats one UTC timestamp differently for different instance timezones", () => {
    const value = "2026-07-15T02:00:00.000Z";
    expect(fullDateTime(value, "Asia/Shanghai")).toContain("10:00:00");
    expect(fullDateTime(value, "UTC")).toContain("02:00:00");
  });

  it("round-trips datetime-local values by instance timezone in a UTC browser", () => {
    expect(new Date("2026-07-15T00:00:00.000Z").getTimezoneOffset()).toBe(0);

    const shanghaiInstant = instanceLocalDateTimeToUtc("2026-07-15T10:45", "Asia/Shanghai");
    expect(shanghaiInstant).toBe("2026-07-15T02:45:00.000Z");
    expect(utcToInstanceDateTimeLocal(shanghaiInstant, "Asia/Shanghai")).toBe("2026-07-15T10:45");

    const newYorkInstant = instanceLocalDateTimeToUtc("2026-07-15T10:45", "America/New_York");
    expect(newYorkInstant).toBe("2026-07-15T14:45:00.000Z");
    expect(utcToInstanceDateTimeLocal(newYorkInstant, "America/New_York")).toBe("2026-07-15T10:45");
  });

  it("rejects a New York DST gap instead of silently shifting it", () => {
    expect(() => instanceLocalDateTimeToUtc("2026-03-08T02:30", "America/New_York")).toThrow(
      /does not exist/u,
    );
  });

  it("makes the New York repeated DST hour deterministic and explicitly rejectable", () => {
    const value = "2026-11-01T01:30";
    expect(instanceLocalDateTimeToUtc(value, "America/New_York")).toBe("2026-11-01T05:30:00.000Z");
    expect(instanceLocalDateTimeToUtc(value, "America/New_York", "later")).toBe(
      "2026-11-01T06:30:00.000Z",
    );
    expect(() => instanceLocalDateTimeToUtc(value, "America/New_York", "reject")).toThrow(
      /occurs more than once/u,
    );
  });
});

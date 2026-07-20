import { describe, expect, it } from "vitest";

import {
  resolveRuntimeMatch,
  runtimeMatchApplies,
  type RouteAudience,
} from "../../src/virtual-models/route-matches.js";

const audience: RouteAudience = {
  users: [
    {
      externalId: "user-pro",
      tags: ["paid", "beta"],
      status: "ACTIVE",
      quota: {
        enabled: true,
        hardLimit: true,
        limitAiuMicros: 10_000_000n,
        consumedAiuMicros: 9_000_000n,
        reservedAiuMicros: 0n,
      },
    },
    { externalId: "user-free", tags: ["free"], status: "ACTIVE", quota: null },
  ],
  groups: new Map([["00000000-0000-4000-8000-000000000701", ["user-pro"]]]),
};

describe("virtual model route matches", () => {
  it("expands saved user groups, tags, and AIU state to fixed user IDs", () => {
    expect(
      resolveRuntimeMatch(
        { user_group: { group_id: "00000000-0000-4000-8000-000000000701" } },
        audience,
      ),
    ).toEqual({ user: { ids: ["user-pro"] } });
    expect(resolveRuntimeMatch({ user_tag: { value: "free" } }, audience)).toEqual({
      user: { ids: ["user-free"] },
    });
    expect(resolveRuntimeMatch({ aiu_state: { value: "low" } }, audience)).toEqual({
      user: { ids: ["user-pro"] },
    });
  });

  it("matches live user properties and call source without a server round trip", () => {
    const instant = new Date("2026-07-20T00:00:00.000Z");
    expect(
      runtimeMatchApplies(
        { user_property: { key: "member_level", operator: "equals", value: "pro" } },
        instant,
        "UTC",
        { userProperties: { member_level: "pro" } },
      ),
    ).toBe(true);
    expect(
      runtimeMatchApplies({ call_source: { value: "voice" } }, instant, "UTC", {
        callSource: "voice",
      }),
    ).toBe(true);
  });

  it("refuses to publish a user group without a current fixed member snapshot", () => {
    expect(() =>
      resolveRuntimeMatch(
        { user_group: { group_id: "00000000-0000-4000-8000-000000000799" } },
        audience,
      ),
    ).toThrow(/unevaluated user group/u);
  });
});

import { describe, expect, it } from "vitest";

import {
  applicationUserDisplayName,
  applicationUserListParameters,
} from "../features/users/user-list";
import type { ApplicationUser } from "../features/users/types";

function user(displayUser: string | null): ApplicationUser {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    user_id: "customer-42",
    display_user: displayUser,
    tags: ["paid"],
    properties: {},
    status: "active",
    blocked_reason: null,
    first_seen_at: "2026-07-18T00:00:00.000Z",
    last_seen_at: "2026-07-18T00:00:00.000Z",
    usage: { calls: 1, tokens: "100", aiu_micros: "1000000" },
    quota: {
      limit_aiu_micros: "10000000",
      used_aiu_micros: "1000000",
      reserved_aiu_micros: "0",
      remaining_aiu_micros: "9000000",
      hard_limit: true,
      period: "lifetime",
      period_start: null,
      period_end: null,
    },
  };
}

describe("application user list", () => {
  it("shows display_user first and falls back to user_id", () => {
    expect(applicationUserDisplayName(user("Ada"))).toBe("Ada");
    expect(applicationUserDisplayName(user(null))).toBe("customer-42");
    expect(applicationUserDisplayName(user("  "))).toBe("customer-42");
  });

  it("sends only active application-user filters", () => {
    expect(
      applicationUserListParameters({
        page: 2,
        search: "Ada",
        status: "blocked",
        tag: "paid",
        groupId: "00000000-0000-4000-8000-000000000002",
        minCalls: "3",
        minTokens: "1000",
        minAiu: "2.5",
        propertyKey: "member_level",
        propertyValue: "pro",
        propertyDataType: "ENUM",
      }).toString(),
    ).toBe(
      "page=2&limit=25&search=Ada&status=blocked&tag=paid&group_id=00000000-0000-4000-8000-000000000002&min_calls=3&min_tokens=1000&min_aiu=2.5&property_key=member_level&property_value=pro",
    );
    expect(
      applicationUserListParameters({
        page: 1,
        search: "",
        status: "all",
        tag: "",
        groupId: "all",
        minCalls: "",
        minTokens: "",
        minAiu: "",
        propertyKey: "",
        propertyValue: "",
        propertyDataType: "",
      }).toString(),
    ).toBe("page=1&limit=25");
  });
});

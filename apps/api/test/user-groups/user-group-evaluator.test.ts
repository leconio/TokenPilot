import { describe, expect, it } from "vitest";

import { Prisma } from "@tokenpilot/db";

import {
  evaluateUserGroup,
  type UserGroupCandidate,
} from "../../src/user-groups/user-group-evaluator.js";

function candidate(overrides: Partial<UserGroupCandidate> = {}): UserGroupCandidate {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    externalId: "customer-42",
    name: "Ada",
    tags: ["paid", "voice"],
    propertiesJson: { member_level: "pro", score: 80, voice_enabled: true },
    status: "ACTIVE",
    lastSeenAt: new Date("2026-07-18T01:00:00.000Z"),
    quota: {
      limitAiuMicros: 10_000_000n,
      consumedAiuMicros: 2_000_000n,
      reservedAiuMicros: 1_000_000n,
    },
    metrics: {
      calls: 12,
      tokens: new Prisma.Decimal("4200"),
      aiuMicros: 2_000_000n,
      cost: new Prisma.Decimal("1.25"),
    },
    ...overrides,
  };
}

describe("user group evaluator", () => {
  it("matches all user, tag, property, and remaining AIU conditions", () => {
    const users = [
      candidate(),
      candidate({
        id: "00000000-0000-4000-8000-000000000002",
        externalId: "trial-1",
        tags: ["trial"],
      }),
    ];
    const matched = evaluateUserGroup(
      {
        match: "all",
        conditions: [
          { field: "tag", operator: "equals", value: "paid" },
          { field: "property", property: "member_level", operator: "equals", value: "pro" },
          { field: "remaining_aiu", operator: "at_least", value: 7_000_000 },
        ],
      },
      users,
    );

    expect(matched.map((user) => user.externalId)).toEqual(["customer-42"]);
  });

  it("supports any-condition matching and numerical usage comparisons", () => {
    const matched = evaluateUserGroup(
      {
        match: "any",
        conditions: [
          { field: "calls", operator: "greater_than", value: 100 },
          { field: "tokens", operator: "between", value: { min: 4_000, max: 5_000 } },
        ],
      },
      [candidate()],
    );

    expect(matched).toHaveLength(1);
  });

  it("treats missing properties distinctly from false and zero values", () => {
    const user = candidate();
    expect(
      evaluateUserGroup(
        {
          match: "all",
          conditions: [
            { field: "property", property: "voice_enabled", operator: "is_set" },
            { field: "property", property: "missing", operator: "is_not_set" },
          ],
        },
        [user],
      ),
    ).toHaveLength(1);
  });

  it("keeps the same external user in another application as a separate candidate", () => {
    const first = candidate();
    const second = candidate({
      id: "00000000-0000-4000-8000-000000000099",
      tags: ["trial"],
      quota: null,
    });
    const definition = {
      match: "all" as const,
      conditions: [{ field: "tag" as const, operator: "equals" as const, value: "paid" }],
    };

    expect(evaluateUserGroup(definition, [first])).toHaveLength(1);
    expect(evaluateUserGroup(definition, [second])).toHaveLength(0);
  });
});

import { describe, expect, it, vi } from "vitest";

import type { ClickHouseClient } from "@tokenpilot/clickhouse";

import { ApplicationUserMetricsRepository } from "../../src/users/user-metrics.repository.js";

describe("ApplicationUserMetricsRepository", () => {
  it("searches current user profiles and usage with bound application filters", async () => {
    const json = vi.fn().mockResolvedValue([
      {
        user_record_id: "00000000-0000-4000-8000-000000000001",
        user_id: "user-42",
        calls: "3",
        tokens: "1200",
        aiu_micros: "2500000",
        cost: "0.75",
        total: "1",
      },
    ]);
    const query = vi.fn().mockResolvedValue({ json });
    const repository = new ApplicationUserMetricsRepository({
      query,
    } as unknown as ClickHouseClient);

    const result = await repository.search("application-a", {
      page: 2,
      limit: 25,
      search: "Ada",
      status: "active",
      tag: "paid",
      externalUserIds: ["user-42"],
      minimumCalls: 3,
      minimumTokens: "1000",
      minimumAiuMicros: 2_000_000n,
      property: { key: "beta_user", value: "true", dataType: "BOOLEAN" },
    });

    expect(result).toMatchObject({
      total: 1,
      rows: [{ id: "00000000-0000-4000-8000-000000000001", externalId: "user-42" }],
    });
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: {
          application_id: "application-a",
          limit: 25,
          offset: 25,
          search: "Ada",
          status: "active",
          tag: "paid",
          user_ids: ["user-42"],
          minimum_calls: 3,
          minimum_tokens: "1000",
          minimum_aiu_micros: "2000000",
          property_key: "beta_user",
          property_boolean: 1,
        },
      }),
    );
    const sql = String(query.mock.calls[0]?.[0]?.query);
    expect(sql).toContain("FROM current_application_user_profiles AS profile");
    expect(sql).toContain("profile.application_id = {application_id:String}");
    expect(sql).toContain("profile.user_boolean_properties");
    expect(sql).not.toContain("application-a");
    expect(sql).not.toContain("user-42");
  });

  it("binds the application and user IDs in ClickHouse without interpolating them into SQL", async () => {
    const json = vi
      .fn()
      .mockResolvedValue([
        { user_id: "user-42", calls: "3", tokens: "1200", aiu_micros: "2500000", cost: "0.75" },
      ]);
    const query = vi.fn().mockResolvedValue({ json });
    const repository = new ApplicationUserMetricsRepository({
      query,
    } as unknown as ClickHouseClient);

    const metrics = await repository.load("application-a", ["user-42"]);

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: { application_id: "application-a", user_ids: ["user-42"] },
      }),
    );
    const sql = String(query.mock.calls[0]?.[0]?.query);
    expect(sql).toContain("application_id = {application_id:String}");
    expect(sql).not.toContain("application-a");
    expect(sql).not.toContain("user-42");
    expect(metrics.get("user-42")).toMatchObject({ calls: 3, aiuMicros: 2_500_000n });
    expect(metrics.get("user-42")?.tokens.toString()).toBe("1200");
    expect(metrics.get("user-42")?.cost.toString()).toBe("0.75");
  });

  it("returns a bounded user trend, model distribution, costs, and recent calls", async () => {
    const responses = [
      [{ bucket: "2026-07-18T00:00:00Z", calls: "2", tokens: "42", aiu_micros: "900000" }],
      [
        {
          model_tag: "company/chat",
          virtual_model: "assistant",
          calls: "2",
          tokens: "42",
          aiu_micros: "900000",
        },
      ],
      [{ model_tag: "company/chat", currency: "USD", amount: "0.12" }],
      [
        {
          event_id: "event-1",
          request_id: "request-1",
          event_time: "2026-07-18T01:00:00.000Z",
          virtual_model: "assistant",
          model_tag: "company/chat",
          status: "success",
        },
      ],
    ];
    const query = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve({ json: vi.fn().mockResolvedValue(responses.shift() ?? []) }),
      );
    const repository = new ApplicationUserMetricsRepository({
      query,
    } as unknown as ClickHouseClient);
    const result = await repository.detail(
      "application-a",
      "user-42",
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-08-01T00:00:00.000Z"),
    );

    expect(query).toHaveBeenCalledTimes(4);
    expect(
      query.mock.calls.every(([input]) => input.query_params.application_id === "application-a"),
    ).toBe(true);
    expect(query.mock.calls.every(([input]) => input.query_params.user_id === "user-42")).toBe(
      true,
    );
    expect(result).toMatchObject({
      trend: [{ calls: 2, tokens: "42", aiu_micros: "900000" }],
      models: [{ model_tag: "company/chat", costs: [{ currency: "USD", amount: "0.12" }] }],
      costs: [{ currency: "USD", amount: "0.12" }],
      recent_calls: [{ event_id: "event-1", status: "success" }],
    });
  });
});

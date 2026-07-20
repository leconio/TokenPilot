import { describe, expect, it, vi } from "vitest";

import type { ClickHouseClient } from "@tokenpilot/clickhouse";
import type { DatabaseClient } from "@tokenpilot/db";

import { readCurrentMetricState } from "../src/metrics/current-state.js";

describe("current metric state", () => {
  it("reads usage, Provider Cost, and unpriced statistics only from ClickHouse", async () => {
    const database = {
      deadLetterEvent: {
        groupBy: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(2),
      },
      backgroundJob: { count: vi.fn().mockResolvedValue(3) },
      ingestionInbox: { count: vi.fn().mockResolvedValue(4) },
      pipelineOutbox: { count: vi.fn().mockResolvedValueOnce(5).mockResolvedValueOnce(1) },
    } as unknown as DatabaseClient;
    const query = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue([
        {
          unpriced_events: "7",
          current_provider_cost: "12.5",
          previous_provider_cost: "8.25",
        },
      ]),
    });
    const clickhouse = { query } as unknown as ClickHouseClient;

    const state = await readCurrentMetricState(
      database,
      clickhouse,
      new Date("2026-07-16T00:00:00.000Z"),
      new Date("2026-07-15T00:00:00.000Z"),
    );

    expect(state).toMatchObject({
      backgroundJobFailures: 3,
      unpricedEvents: 7,
      currentProviderCost: 12.5,
      previousProviderCost: 8.25,
    });
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringMatching(
          /FROM current_usage_events_raw[\s\S]*HAVING argMax\(status, tuple\(authority_outbox_id, rating_event_id\)\)/u,
        ),
        query_params: {
          current_day_start: "2026-07-16T00:00:00.000Z",
          previous_day_start: "2026-07-15T00:00:00.000Z",
        },
        format: "JSONEachRow",
      }),
    );
    expect(query.mock.calls[0]?.[0].query).not.toContain("current_stage = 'unpriced'");
    expect(query.mock.calls[0]?.[0].query).not.toContain("instance_id");
    expect(query.mock.calls[0]?.[0].query_params).not.toHaveProperty("instance_id");
  });
});

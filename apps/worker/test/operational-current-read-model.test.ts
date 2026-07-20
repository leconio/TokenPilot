import { describe, expect, it, vi } from "vitest";

import type { ClickHouseClient } from "@tokenpilot/clickhouse";
import { BackgroundJobStatus, BackgroundJobType, type DatabaseClient } from "@tokenpilot/db";

import { OperationalProcessor } from "../src/operational-processor.js";

function backgroundJob(kind: BackgroundJobType) {
  return {
    id: "job-id",
    type: kind,
    idempotencyKey: "job-key",
    status: BackgroundJobStatus.QUEUED,
    resultJson: null,
  };
}

describe("OperationalProcessor current read model", () => {
  it("alerts from the canonical current Provider Cost pointer", async () => {
    const createAudit = vi.fn().mockResolvedValue({});
    const clickHouseQuery = vi.fn().mockResolvedValue({
      json: () => Promise.resolve([{ unpriced_count: "2" }]),
    });
    const database = {
      backgroundJob: {
        upsert: vi.fn().mockResolvedValue(backgroundJob(BackgroundJobType.MAINTENANCE)),
        update: vi.fn().mockResolvedValue({}),
      },
      auditLog: { create: createAudit },
    } as unknown as DatabaseClient;
    const result = await new OperationalProcessor(database, {
      clickhouse: { query: clickHouseQuery } as unknown as ClickHouseClient,
      exportDirectory: "/unused",
      connectorStaleAfterSeconds: 60,
    }).process({ kind: "unpriced.alert", idempotencyKey: "job-key", parameters: {} });

    expect(result.result).toEqual({ unpriced_count: 2, alert: true });
    expect(createAudit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "alert.unpriced",
        objectType: "current_usage_events_raw",
        afterJson: { count: 2 },
      }),
    });
    expect(clickHouseQuery.mock.calls[0]?.[0].query).toContain("current_rating_events");
    expect(clickHouseQuery.mock.calls[0]?.[0].query).not.toContain("instance_id");
    expect(clickHouseQuery.mock.calls[0]?.[0].query_params).toEqual({});
  });
});

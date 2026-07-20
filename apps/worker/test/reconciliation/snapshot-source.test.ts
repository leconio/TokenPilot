import { describe, expect, it, vi } from "vitest";

import type { ClickHouseClient } from "@tokenpilot/clickhouse";
import type { DatabaseClient, Prisma } from "@tokenpilot/db";
import { planReconciliationRun } from "@tokenpilot/reconciliation-engine";

import { DualStoreReconciliationSnapshotSource } from "../../src/reconciliation/snapshot-source.js";

const plan = planReconciliationRun({
  applicationId: "00000000-0000-4000-8000-000000000001",
  runType: "manual",
  rangeStart: "2026-07-16T00:00:00.000Z",
  rangeEnd: "2026-07-16T01:00:00.000Z",
});

describe("dual-store reconciliation snapshot source", () => {
  it("loads ClickHouse inside one application and exposes physical duplicates", async () => {
    const query = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue([
        {
          application_id: plan.applicationId,
          bucket_start: "2026-07-16 00:00:00.000",
          virtual_model: "",
          model_id: "",
          request_model: "",
          provider: "",
          user_id: "user-1",
          event_count: "1",
          duplicate_projection_count: "2",
          input_tokens: "0",
          cached_input_tokens: "0",
          output_tokens: "0",
          provider_cost: "0",
          aiu_micros: "0",
          unpriced_count: "1",
          unrated_count: "1",
          sample_event_ids: ["event-current"],
          cost_version_id: "",
          aiu_version_id: "",
        },
      ]),
    });
    const source = new DualStoreReconciliationSnapshotSource(
      {} as DatabaseClient,
      { query } as unknown as ClickHouseClient,
    );

    const rows = await source.loadClickHouse(plan);
    const statement = query.mock.calls[0]?.[0];

    expect(rows[0]).toMatchObject({
      duplicateProjectionCount: "2",
      dimensions: { bucketStart: "2026-07-16T00:00:00.000Z" },
      metrics: { unpricedCount: "1", unratedCount: "1" },
    });
    expect(statement.query).toContain(
      "count() - uniqExact(event.event_id) AS duplicate_projection_count",
    );
    expect(statement.query).toContain("event.application_id AS application_id");
    expect(statement.query).toContain("event.user_id AS user_id");
    expect(statement.query).toContain("provider_cost_status");
    expect(statement.query).toContain("aiu_status");
    expect(statement.query).toContain("rating.provider_cost_status = 'unpriced'");
    expect(statement.query).toContain("rating.aiu_status = 'unrated'");
    expect(statement.query).not.toContain("official_provider_cost_count");
    expect(statement.query).not.toContain("official_aiu_count");
    expect(statement.query).toContain("event.application_id = {application_id:String}");
    expect(statement.query_params).toEqual({
      application_id: plan.applicationId,
      range_start: plan.rangeStart,
      range_end: plan.rangeEnd,
    });
  });

  it("builds the PostgreSQL authority snapshot from application ratings", async () => {
    let statement = "";
    const queryRaw = vi.fn().mockImplementation(async (sql: Prisma.Sql) => {
      statement = sql.strings.join("?");
      return [];
    });
    const source = new DualStoreReconciliationSnapshotSource(
      { $queryRaw: queryRaw } as unknown as DatabaseClient,
      {} as ClickHouseClient,
    );

    await source.loadPostgres(plan);

    expect(statement).toContain("application_usage_ratings AS rating");
    expect(statement).toContain("registry.application_id");
    expect(statement).toContain("rating.input_tokens");
    expect(statement).toContain("rating.aiu_micros");
    expect(statement).toContain("MIN(rating.cost_version_id::text)");
    expect(statement).toContain("MIN(rating.aiu_version_id::text)");
    expect(statement).not.toContain("MIN(rating.cost_version_id)");
    expect(statement).not.toContain("MIN(rating.aiu_version_id)");
  });

  it("scopes the ClickHouse watermark by reconciliation range, not process identity", async () => {
    const query = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ watermark: "2026-07-16 00:30:00.000" }]),
    });
    const database = {
      usageEventRegistry: {
        aggregate: vi.fn().mockResolvedValue({
          _max: { eventTime: new Date("2026-07-16T00:30:00.000Z") },
        }),
      },
      clickhouseSyncState: {
        findFirst: vi.fn().mockResolvedValue({
          lastSuccessAt: new Date("2026-07-16T00:31:00.000Z"),
        }),
      },
    } as unknown as DatabaseClient;
    const source = new DualStoreReconciliationSnapshotSource(database, {
      query,
    } as unknown as ClickHouseClient);

    await expect(source.loadWatermarks(plan)).resolves.toMatchObject({
      pgEventTime: "2026-07-16T00:30:00.000Z",
      chEventTime: "2026-07-16T00:30:00.000Z",
    });
    expect(query.mock.calls[0]?.[0].query).not.toContain("instance_id");
    expect(query.mock.calls[0]?.[0].query_params).toEqual({
      application_id: plan.applicationId,
      range_start: plan.rangeStart,
      range_end: plan.rangeEnd,
    });
  });
});

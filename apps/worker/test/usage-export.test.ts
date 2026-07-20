import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ClickHouseClient } from "@tokenpilot/clickhouse";

import { countUnpricedUsage, generateUsageExport } from "../src/usage-export.js";

function queryResult(rows: readonly Readonly<Record<string, unknown>>[]) {
  return { json: () => Promise.resolve(rows) };
}

describe("usage export", () => {
  it("streams a bounded private CSV from ClickHouse and neutralizes spreadsheet formulas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "usage-export-"));
    const query = vi
      .fn()
      .mockResolvedValueOnce(queryResult([{ row_count: "1" }]))
      .mockResolvedValueOnce(
        queryResult([
          {
            event_id: "event-1",
            request_id: "request-1",
            attempt_id: "attempt-1",
            operation_id: "operation-1",
            event_time: "2026-07-16 00:00:00.000",
            application_version: "1.2.3",
            sdk_version: "0.4.0",
            connector_version: "0.5.0",
            config_version: "7",
            user_id: "user-1",
            display_user: "=SUM(A1:A2)",
            session_id: "session-1",
            conversation_id: "conversation-1",
            trace_id: "trace-1",
            virtual_model: "text.fast",
            model_id: "model-id",
            request_model: "+formula-model",
            provider: "provider",
            result_status: "success",
            provider_cost_status: "official",
            provider_cost: "0.010000000000000000",
            provider_cost_currency: "USD",
            aiu_status: "official",
            aiu_micros: "42",
            aiu_rating_count: "1",
            official_sync_count: "2",
            clickhouse_raw_synced_at: "2026-07-16 00:00:01.000",
            clickhouse_official_synced_at: "2026-07-16 00:00:02.000",
          },
        ]),
      );
    const clickhouse = { query } as unknown as ClickHouseClient;

    const result = await generateUsageExport({
      clickhouse,
      applicationId: "application-one",
      outputDirectory: directory,
      identity: "job:one/unsafe",
      from: new Date("2026-07-15T00:00:00.000Z"),
      to: new Date("2026-07-17T00:00:00.000Z"),
    });
    const contents = await readFile(result.path, "utf8");
    expect(result.rowCount).toBe(1);
    expect(result.bytes).toBe(Buffer.byteLength(contents));
    expect(result.path).toMatch(/job_one_unsafe\.csv$/u);
    expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    expect(contents).toContain("'=SUM(A1:A2)");
    expect(contents).toContain("'+formula-model");
    expect(contents).toContain("0.010000000000000000");
    expect(contents).toContain('"42"');
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0].query).toContain("current_usage_events_raw");
    expect(query.mock.calls[1]?.[0].query).toContain("current_rating_events");
    expect(query.mock.calls[0]?.[0].query).toContain("event.application_id");
    expect(query.mock.calls[1]?.[0].query).toContain(
      "rating.application_id = event.application_id",
    );
    expect(query.mock.calls[1]?.[0].query_params).toMatchObject({
      application_id: "application-one",
      after_event_id: "",
    });
  });

  it("rejects oversized exports before loading ClickHouse pages", async () => {
    const query = vi.fn().mockResolvedValueOnce(queryResult([{ row_count: "1000001" }]));
    await expect(
      generateUsageExport({
        clickhouse: { query } as unknown as ClickHouseClient,
        applicationId: "application-one",
        outputDirectory: "/unused",
        identity: "too-large",
        from: new Date(0),
        to: new Date(1),
      }),
    ).rejects.toThrow(/row limit/u);
    expect(query).toHaveBeenCalledOnce();
  });

  it("uses a stable ClickHouse event cursor after every full 1,000-row page", async () => {
    const directory = await mkdtemp(join(tmpdir(), "usage-export-pages-"));
    const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
      event_id: `event-${String(index).padStart(4, "0")}`,
      aiu_rating_count: "0",
      official_sync_count: "0",
    }));
    const query = vi
      .fn()
      .mockResolvedValueOnce(queryResult([{ row_count: "1001" }]))
      .mockResolvedValueOnce(queryResult(firstPage))
      .mockResolvedValueOnce(
        queryResult([{ event_id: "event-1000", aiu_rating_count: "0", official_sync_count: "0" }]),
      );
    await expect(
      generateUsageExport({
        clickhouse: { query } as unknown as ClickHouseClient,
        applicationId: "application-one",
        outputDirectory: directory,
        identity: "paged",
        from: new Date(0),
        to: new Date(1),
      }),
    ).resolves.toMatchObject({ rowCount: 1_001 });
    expect(query.mock.calls[1]?.[0].query_params.after_event_id).toBe("");
    expect(query.mock.calls[2]?.[0].query_params.after_event_id).toBe("event-0999");
  });

  it("counts unrated Provider Cost events only from current ClickHouse views", async () => {
    const query = vi.fn().mockResolvedValueOnce(queryResult([{ unpriced_count: "2" }]));
    await expect(
      countUnpricedUsage({
        clickhouse: { query } as unknown as ClickHouseClient,
      }),
    ).resolves.toBe(2);
    const request = query.mock.calls[0]?.[0];
    expect(request.query).toContain("current_usage_events_raw");
    expect(request.query).toContain("current_rating_events");
    expect(request.query).toContain("HAVING argMax(status");
    expect(request.query).toContain("authority_outbox_id");
    expect(request.query).toContain("event.application_id, event.event_id");
    expect(request.query).not.toContain("argMax(rating_stage");
    expect(request.query).not.toContain("instance_id");
    expect(request.query_params).toEqual({});
  });
});

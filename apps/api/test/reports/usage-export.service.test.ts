import { describe, expect, it, vi } from "vitest";
import type { Readable } from "node:stream";

import type { UsageReportItem } from "@tokenpilot/contracts";
import type { DatabaseClient } from "@tokenpilot/db";

import type { AuditContextService } from "../../src/audit-context.js";
import type { HealthService } from "../../src/health.controller.js";
import type { AnalyticsReportRepository } from "../../src/reports/analytics-repository.js";
import { encodeUsageCursor } from "../../src/reports/query.js";
import { CurrentReportsController } from "../../src/reports/reports.controller.js";
import { ReportsService } from "../../src/reports/reports.service.js";

const range = {
  from: "2028-01-01T00:00:00.000Z",
  to: "2028-01-02T00:00:00.000Z",
};

function item(eventId: string, eventTime: string): UsageReportItem {
  return {
    event_id: eventId,
    request_id: `request-${eventId}`,
    attempt_id: "attempt-1",
    attempt_index: 0,
    is_final_attempt: true,
    operation_id: null,
    event_time: eventTime,
    received_at: eventTime,
    schema_version: "2.0",
    application_version: null,
    sdk_version: null,
    connector_version: null,
    config_version: null,
    user_id: "customer-1",
    display_user: "Customer",
    session_id: null,
    conversation_id: null,
    trace_id: null,
    virtual_model: "chat",
    model_id: null,
    connection_id: null,
    connection_driver: null,
    request_model: "company/chat",
    provider: null,
    status: "success",
    route_reason: null,
    fallback_from: null,
    latency_ms: 10,
    input_tokens: "1",
    cached_input_tokens: "0",
    output_tokens: "1",
    reasoning_output_tokens: "0",
    total_tokens: "2",
    provider_cost_status: null,
    provider_cost_amount: null,
    provider_cost_currency: null,
    aiu_status: null,
    aiu_micros: null,
    aiu_chargeable: null,
    quota_status: null,
    event_properties: {},
    user_properties: {},
  };
}

async function streamText(stream: Readable): Promise<string> {
  let value = "";
  for await (const chunk of stream) value += chunk.toString();
  return value;
}

describe("filtered Usage CSV export", () => {
  it("requires the separate raw-usage permission", () => {
    expect(
      Reflect.getMetadata("required-machine-scope", CurrentReportsController.prototype.usageExport),
    ).toBe("usage:read");
  });

  it("walks every keyset page inside the authenticated application", async () => {
    const first = item("event-2", "2028-01-01T02:00:00.000Z");
    const second = item("event-1", "2028-01-01T01:00:00.000Z");
    const next = encodeUsageCursor({
      eventTime: first.event_time,
      eventId: first.event_id,
      position: 1,
    });
    const usage = vi
      .fn()
      .mockResolvedValueOnce({ items: [first], page_size: 200, total: 2, next_cursor: next })
      .mockResolvedValueOnce({ items: [second], page_size: 200, total: 2, next_cursor: null });
    const analytics = { usage } as unknown as AnalyticsReportRepository;
    const health = {
      assertReady: vi.fn().mockResolvedValue({
        postgres: "healthy",
        redis: "healthy",
        clickhouse: "healthy",
      }),
    } as unknown as HealthService;
    const database = {
      application: { findUnique: vi.fn().mockResolvedValue({ timezone: "Asia/Shanghai" }) },
      propertyDefinition: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as DatabaseClient;
    const context = {
      current: () => ({
        actorId: "user:test",
        applicationId: "00000000-0000-4000-8000-000000000001",
        applicationSlug: "test",
      }),
    } as unknown as AuditContextService;
    const service = new ReportsService(analytics, health, context, database);

    const stream = await service.exportUsage(range);

    expect(usage).toHaveBeenCalledTimes(1);
    const csv = await streamText(stream);

    expect(csv).toContain(first.event_id);
    expect(csv).toContain(second.event_id);
    expect(usage).toHaveBeenCalledTimes(2);
    expect(usage.mock.calls[0]?.[0]).toMatchObject({
      applicationId: "00000000-0000-4000-8000-000000000001",
      timezone: "Asia/Shanghai",
      pageSize: 200,
      usageCursor: null,
    });
    expect(usage.mock.calls[1]?.[0]).toMatchObject({
      applicationId: "00000000-0000-4000-8000-000000000001",
      usageCursor: { eventId: first.event_id, position: 1 },
      knownUsageTotal: 2,
    });
  });
});

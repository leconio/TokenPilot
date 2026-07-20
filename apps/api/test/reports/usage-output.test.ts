import { describe, expect, it, vi } from "vitest";

import type { UsageReportItem } from "@tokenpilot/contracts";
import type { DatabaseClient } from "@tokenpilot/db";

import {
  loadUsageOutputPolicy,
  maskUsageItem,
  usageItemsToCsv,
} from "../../src/reports/usage-output.js";

function usageItem(): UsageReportItem {
  return {
    event_id: "event-1",
    request_id: "request-1",
    attempt_id: "attempt-1",
    operation_id: null,
    event_time: "2028-01-01T00:00:00.000Z",
    received_at: "2028-01-01T00:00:01.000Z",
    schema_version: "2.0",
    application_version: "3.1.4",
    sdk_version: "0.2.0",
    connector_version: "0.2.0",
    config_version: "12",
    user_id: "=spreadsheet-formula",
    display_user: "演示用户",
    session_id: null,
    conversation_id: null,
    trace_id: null,
    virtual_model: "chat",
    model_id: null,
    model_tag: "company/chat",
    provider: "openai",
    status: "success",
    route_reason: "default",
    fallback_from: null,
    latency_ms: 120,
    input_tokens: "10",
    cached_input_tokens: "2",
    output_tokens: "4",
    reasoning_output_tokens: "1",
    total_tokens: "14",
    provider_cost_status: "official",
    provider_cost_amount: "0.001",
    provider_cost_currency: "USD",
    aiu_status: "official",
    aiu_micros: "1000",
    aiu_chargeable: true,
    quota_status: "allowed",
    event_properties: { next_action: "continue", voice_text: "private voice" },
    user_properties: { plan: "pro", private_note: "do not export" },
  };
}

describe("usage report output privacy", () => {
  it("masks sensitive values in API rows and omits them from CSV exports", async () => {
    const database = {
      propertyDefinition: {
        findMany: vi.fn().mockResolvedValue([
          {
            key: "next_action",
            displayName: "下一步",
            scope: "EVENT",
            sensitive: false,
          },
          {
            key: "voice_text",
            displayName: "语音内容",
            scope: "EVENT",
            sensitive: true,
          },
          { key: "plan", displayName: "套餐", scope: "USER", sensitive: false },
          {
            key: "private_note",
            displayName: "内部备注",
            scope: "USER",
            sensitive: true,
          },
        ]),
      },
    } as unknown as DatabaseClient;
    const policy = await loadUsageOutputPolicy(database, "application-a");
    const masked = maskUsageItem(usageItem(), policy);

    expect(masked.event_properties.voice_text).toBe("[hidden]");
    expect(masked.user_properties.private_note).toBe("[hidden]");
    const csv = usageItemsToCsv([masked], policy);
    expect(csv).toContain("事件字段：下一步");
    expect(csv).toContain("用户字段：套餐");
    expect(csv).toContain("continue");
    expect(csv).toContain("pro");
    expect(csv).not.toContain("语音内容");
    expect(csv).not.toContain("private voice");
    expect(csv).not.toContain("内部备注");
    expect(csv).not.toContain("do not export");
    expect(csv).toContain("'=spreadsheet-formula");
  });
});

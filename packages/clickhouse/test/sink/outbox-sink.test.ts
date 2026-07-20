import { describe, expect, it } from "vitest";

import { mapClickHouseOutbox } from "../../src/index.js";
import { normalized, record } from "./outbox-sink.fixtures.js";

describe("ClickHouse PG outbox mapper", () => {
  it("projects a versioned application user profile for segmentation", () => {
    const mapped = mapClickHouseOutbox(
      record(9n, "application_user.profile", {
        user_record_id: "123e4567-e89b-42d3-a456-426614174001",
        user_id: "user-1",
        display_user: "Ada",
        tags: ["paid", "beta", "paid"],
        status: "active",
        first_seen_at: "2026-07-15T00:00:00.000Z",
        last_seen_at: "2026-07-16T00:00:00.000Z",
        profile_updated_at: "2026-07-16T01:00:00.000Z",
        properties: { member_level: "VVIP", interests: ["AI", "voice"] },
      }),
      { environment: "test" },
    );
    expect(mapped.rows.application_user_profiles).toEqual([
      expect.objectContaining({
        user_id: "user-1",
        display_user: "Ada",
        tags: ["beta", "paid"],
        status: "active",
        profile_version: "9",
        sink_delivery_id: "outbox:9:user-profile",
        user_enum_properties: { member_level: "VVIP" },
        user_text_list_properties: { interests: ["AI", "voice"] },
      }),
    ]);
  });

  it("redacts secrets and emits stable raw and usage delivery identities", () => {
    const event = {
      ...normalized,
      extension: { api_key: "must-not-leave-postgres", allowed: "yes" },
      usage: { uncached_input_tokens: "12" },
    };
    const raw = mapClickHouseOutbox(
      record(10n, "usage_events_raw", {
        event,
        normalized,
        resolution: { modelId: "base-model-1" },
        payload_hash: "a".repeat(64),
      }),
      { environment: "test" },
    ).rows.usage_events_raw![0]!;
    expect(raw).toMatchObject({
      source_outbox_id: "10",
      sink_delivery_id: "outbox:10:raw",
      model_id: "base-model-1",
      model_tag: "provider/model",
      user_id: "user-1",
      conversation_id: "conversation-1",
      user_tags: [],
      virtual_model: "assistant",
      event_text_properties: { next_action: "summarize" },
      event_boolean_properties: { voice_enabled: 1 },
      user_enum_properties: { member_level: "VVIP" },
      user_text_list_properties: { interests: ["AI", "voice"] },
    });
    expect(String(raw.raw_payload)).not.toContain("must-not-leave-postgres");
    expect(String(raw.raw_payload)).toContain('"allowed":"yes"');

    const usage = mapClickHouseOutbox(
      record(11n, "usage_lines", {
        normalized,
        resolution: { modelId: "base-model-1" },
        user_tags: ["paid", "beta"],
      }),
      { environment: "test" },
    ).rows.usage_lines![0]!;
    expect(usage).toMatchObject({
      source_outbox_id: "11",
      sink_delivery_id: "outbox:11:usage:0",
      quantity: "12",
      usage_type: "uncached_input_token",
      user_tags: ["beta", "paid"],
    });
  });

  it("keeps clone provenance while reusing the original ClickHouse delivery identity", () => {
    const payload = {
      event: { ...normalized, usage: { request_count: "1" } },
      normalized,
      resolution: { modelId: "base-model-1" },
      payload_hash: "a".repeat(64),
    };
    const clone = {
      ...record(100n, "usage_events_raw", payload),
      replayOfOutboxId: 10n,
    };
    expect(
      mapClickHouseOutbox(clone, { environment: "test" }).rows.usage_events_raw![0],
    ).toMatchObject({
      source_outbox_id: "100",
      sink_delivery_id: "outbox:10:raw",
    });
    for (const replayOfOutboxId of [100n, 101n]) {
      expect(() =>
        mapClickHouseOutbox({ ...clone, replayOfOutboxId }, { environment: "test" }),
      ).toThrow(/replay source identity/u);
    }
  });

  it("keeps application-user profile ordering stable across a fresh replay", () => {
    const clone = {
      ...record(100n, "application_user.profile", {
        user_record_id: "123e4567-e89b-42d3-a456-426614174001",
        user_id: "user-1",
        display_user: "Ada",
        tags: ["paid"],
        status: "active",
        first_seen_at: "2026-07-15T00:00:00.000Z",
        last_seen_at: "2026-07-16T00:00:00.000Z",
        profile_updated_at: "2026-07-16T01:00:00.000Z",
        properties: {},
      }),
      replayOfOutboxId: 9n,
    };
    expect(
      mapClickHouseOutbox(clone, { environment: "test" }).rows.application_user_profiles![0],
    ).toMatchObject({
      profile_version: "9",
      sink_delivery_id: "outbox:9:user-profile",
      source_outbox_id: "100",
    });
  });

  it("projects exact signed Provider Cost deltas from the canonical ledger payload", () => {
    const mapped = mapClickHouseOutbox(
      record(20n, "provider_cost.official_delta", {
        event_id: normalized.event_id,
        event_time: normalized.event_time,
        request_id: "request-1",
        attempt_id: "attempt-1",
        operation_id: "operation-1",
        instance_id: "gateway-1",
        user_id: "user-1",
        virtual_model: "assistant",
        model_id: "base-model-1",
        model_tag: "provider/model",
        provider: "provider",
        status: "official",
        attempt_outcome: "success",
        route_reason: "primary",
        rating_id: "new-rating",
        replaces_rating_id: "old-rating",
        rating_fingerprint: `sha256:${"b".repeat(64)}`,
        price_version_id: "price-version-1",
        deltas: [
          {
            rating_event_id: "new-rating:correction:0",
            rating_sign: 1,
            rating_stage: "correction",
            amount: "0.250000000000000000",
            currency: "USD",
            price_version_id: "price-version-1",
            calculation_version: "provider-cost",
            rating_fingerprint: `sha256:${"b".repeat(64)}`,
            reason: "corrected official provider cost rating",
          },
        ],
      }),
      { environment: "test" },
    );
    expect(mapped.rows.rating_events).toEqual([
      expect.objectContaining({
        rating_sign: 1,
        rating_stage: "correction",
        amount_decimal: "0.250000000000000000",
        operation_id: "operation-1",
        user_id: "user-1",
        virtual_model: "assistant",
        model_id: "base-model-1",
        model_tag: "provider/model",
        provider: "provider",
      }),
    ]);
  });

  it("maps provisional and administrative adjustment facts as distinct signed events", () => {
    const base = {
      event_id: normalized.event_id,
      event_time: normalized.event_time,
      request_id: "request-1",
      attempt_id: "attempt-1",
      rating_id: "rating-1",
      status: "provisional",
      attempt_outcome: "success",
    };
    const delta = {
      rating_event_id: "rating-1:provisional:0",
      rating_sign: 1,
      rating_stage: "provisional",
      amount: "1.250000000000000000",
      currency: "USD",
      price_version_id: "price-version-1",
      calculation_version: "provider-cost",
      rating_fingerprint: `sha256:${"e".repeat(64)}`,
      reason: "synced snapshot provisional provider cost",
    };
    const provisional = mapClickHouseOutbox(
      record(22n, "provider_cost.provisional", { ...base, deltas: [delta] }),
      { environment: "test" },
    ).rows.rating_events![0]!;
    expect(provisional).toMatchObject({
      rating_stage: "provisional",
      rating_sign: 1,
      amount_decimal: "1.250000000000000000",
    });

    const adjustment = mapClickHouseOutbox(
      record(23n, "provider_cost.adjustment", {
        ...base,
        status: "official",
        deltas: [
          {
            ...delta,
            rating_event_id: "ledger-adjustment-1",
            rating_sign: -1,
            rating_stage: "correction",
            amount: "0.125000000000000000",
            reason: "administrative provider cost adjustment",
          },
        ],
      }),
      { environment: "test" },
    ).rows.rating_events![0]!;
    expect(adjustment).toMatchObject({
      rating_stage: "correction",
      rating_sign: -1,
      amount_decimal: "0.125000000000000000",
    });
  });

  it("preserves signed AIU correction lines so their net equals new minus replaced", () => {
    const mapped = mapClickHouseOutbox(
      record(21n, "aiu.official_delta", {
        event_id: normalized.event_id,
        event_time: normalized.event_time,
        request_id: "request-1",
        attempt_id: "attempt-1",
        status: "official",
        attempt_outcome: "success",
        deltas: [
          {
            rating_event_id: "new:reversal:old",
            rating_sign: -1,
            rating_stage: "reversal",
            rating_fingerprint: `sha256:${"c".repeat(64)}`,
            aiu_rate_version_id: "rate-old",
            calculation_version: "aiu",
            reason: "superseded",
            total_aiu_micros: "100",
            lines: [{ usage_type: "request", aiu_micros: "100" }],
          },
          {
            rating_event_id: "new:correction:new",
            rating_sign: 1,
            rating_stage: "correction",
            rating_fingerprint: `sha256:${"d".repeat(64)}`,
            aiu_rate_version_id: "rate-new",
            calculation_version: "aiu",
            reason: "corrected",
            total_aiu_micros: "130",
            lines: [{ usage_type: "request", aiu_micros: "130" }],
          },
        ],
      }),
      { environment: "test" },
    );
    const net = mapped.rows.rating_events!.reduce(
      (sum, row) => sum + BigInt(row.rating_sign as number) * BigInt(row.aiu_micros as string),
      0n,
    );
    expect(net).toBe(30n);
  });

  it("maps AIU provisional facts and rejects provisional stages on the official event", () => {
    const delta = {
      rating_event_id: "aiu-rating:provisional",
      rating_sign: 1,
      rating_stage: "provisional",
      rating_fingerprint: `sha256:${"a".repeat(64)}`,
      aiu_rate_version_id: "rate-current",
      calculation_version: "aiu-rating",
      reason: "synced snapshot provisional AIU",
      total_aiu_micros: "5000000",
      lines: [{ usage_type: "uncached_input_token", aiu_micros: "5000000" }],
    };
    const mapped = mapClickHouseOutbox(
      record(24n, "aiu.provisional", {
        event_id: normalized.event_id,
        event_time: normalized.event_time,
        request_id: "request-1",
        attempt_id: "attempt-1",
        status: "provisional",
        attempt_outcome: "success",
        deltas: [delta],
      }),
      { environment: "test" },
    ).rows.rating_events![0]!;
    expect(mapped).toMatchObject({
      rating_kind: "aiu",
      rating_stage: "provisional",
      rating_sign: 1,
      aiu_micros: "5000000",
    });
    expect(() =>
      mapClickHouseOutbox(
        record(25n, "aiu.official_delta", {
          event_id: normalized.event_id,
          event_time: normalized.event_time,
          status: "official",
          attempt_outcome: "success",
          deltas: [delta],
        }),
        { environment: "test" },
      ),
    ).toThrow(/cannot project rating stage provisional/u);
  });
});

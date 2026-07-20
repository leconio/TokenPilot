import { describe, expect, it } from "vitest";

import {
  runtimeSnapshotSchema,
  runtimeUserReservationReleaseSchema,
  runtimeUserReservationRequestSchema,
  runtimeUserReservationResponseSchema,
  runtimeUserReservationSettlementSchema,
  virtualModelRouteMatchSchema,
} from "../src/index.js";

const target = {
  model_id: "00000000-0000-4000-8000-000000000101",
  model_tag: "openai/gpt-5-mini",
  provider: "openai",
  route_tag: "cp:assistant:default",
  fallback_order: 0,
  weight: 1,
} as const;

const snapshot = {
  schema_version: "2.0",
  application_id: "00000000-0000-4000-8000-000000000099",
  version: "runtime-current",
  etag: `sha256:${"a".repeat(64)}`,
  signature: `sha256:${"c".repeat(64)}`,
  expires_at: "2026-07-19T14:00:00.000Z",
  routing: {
    assistant: {
      virtual_model_id: "00000000-0000-4000-8000-000000000100",
      configuration_version: 7,
      configuration_etag: `sha256:${"b".repeat(64)}`,
      published_at: "2026-07-18T14:00:00.000Z",
      timezone: "Asia/Shanghai",
      default: {
        route_tag: "cp:assistant:default",
        selection_mode: "ordered",
        targets: [target],
      },
      rules: [],
    },
  },
  aiu: { enabled: true, mode: "observe", unrated_model_policy: "alert_only" },
  access: { application_enabled: true, blocked_user_ids: ["blocked-user"] },
  dimensions: { analytics_allowed_keys: ["client", "region"] },
} as const;

describe("Runtime Snapshot", () => {
  it("accepts virtual-model routing, AIU controls, and application-user access", () => {
    expect(runtimeSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("rejects inconsistent AIU state, duplicate users, and invalid fallback order", () => {
    expect(
      runtimeSnapshotSchema.safeParse({ ...snapshot, aiu: { ...snapshot.aiu, mode: "disabled" } })
        .success,
    ).toBe(false);
    expect(
      runtimeSnapshotSchema.safeParse({
        ...snapshot,
        access: { ...snapshot.access, blocked_user_ids: ["blocked-user", "blocked-user"] },
      }).success,
    ).toBe(false);
    expect(
      runtimeSnapshotSchema.safeParse({
        ...snapshot,
        routing: {
          assistant: {
            ...snapshot.routing.assistant,
            default: {
              ...snapshot.routing.assistant.default,
              targets: [{ ...target, fallback_order: 1 }],
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("keeps all current virtual-model route conditions", () => {
    for (const match of [
      { override_active: true },
      { schedule: { days: [1, 2], from: "09:00", to: "18:00" } },
      { user: { ids: ["user-1"] } },
      { user_property: { key: "plan", operator: "equals", value: "pro" } },
      { call_source: { value: "voice" } },
      { user_group: { group_id: "00000000-0000-4000-8000-000000000201" } },
      { user_tag: { value: "beta" } },
      { aiu_state: { value: "low" } },
    ]) {
      expect(virtualModelRouteMatchSchema.safeParse(match).success).toBe(true);
    }
  });
});

describe("Runtime user AIU reservations", () => {
  const request = {
    user_id: "user-1",
    display_user: "Ada",
    user_properties: { plan: "pro", tags: ["beta"] },
    operation_id: "operation-1",
    virtual_model: "assistant",
    candidate_model_ids: [target.model_id],
    estimated_aiu_micros: "2500000",
  } as const;

  it("accepts the request, response, settlement, and release contracts", () => {
    expect(runtimeUserReservationRequestSchema.parse(request)).toEqual(request);
    expect(
      runtimeUserReservationResponseSchema.safeParse({
        allowed: true,
        reason: "reserved",
        user: {
          id: "user-record-1",
          limit_aiu_micros: "10000000",
          used_aiu_micros: "1000000",
          reserved_aiu_micros: "2500000",
          remaining_aiu_micros: "6500000",
        },
        reservation: {
          id: "reservation-1",
          token: "x".repeat(64),
          reserved_aiu_micros: "2500000",
          expires_at: "2026-07-18T15:00:00.000Z",
        },
      }).success,
    ).toBe(true);
    expect(
      runtimeUserReservationSettlementSchema.safeParse({
        reservation_token: "x".repeat(64),
        settled_aiu_micros: "2400000",
      }).success,
    ).toBe(true);
    expect(
      runtimeUserReservationReleaseSchema.safeParse({
        reservation_token: "x".repeat(64),
        reason: "request_failed",
      }).success,
    ).toBe(true);
  });

  it("requires unique model candidates and forbids reservations on denied responses", () => {
    expect(
      runtimeUserReservationRequestSchema.safeParse({
        ...request,
        candidate_model_ids: [target.model_id, target.model_id],
      }).success,
    ).toBe(false);
    expect(
      runtimeUserReservationResponseSchema.safeParse({
        allowed: false,
        reason: "aiu_exhausted",
        user: {
          id: "user-record-1",
          limit_aiu_micros: "10000000",
          used_aiu_micros: "10000000",
          reserved_aiu_micros: "0",
          remaining_aiu_micros: "0",
        },
        reservation: {
          id: "reservation-1",
          token: "x".repeat(64),
          reserved_aiu_micros: "1",
          expires_at: "2026-07-18T15:00:00.000Z",
        },
      }).success,
    ).toBe(false);
  });
});

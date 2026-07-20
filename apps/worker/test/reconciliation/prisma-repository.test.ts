import { describe, expect, it } from "vitest";

import { Prisma } from "@tokenpilot/db";
import type {
  ReconciliationDiff,
  ReconciliationDimensions,
  ReconciliationMetrics,
} from "@tokenpilot/reconciliation-engine";

import {
  persistedDimensions,
  persistedMetrics,
  restoredDimensions,
  restoredMetrics,
  toPersistedDiff,
} from "../../src/reconciliation/prisma-repository.js";

const dimensions: ReconciliationDimensions = {
  applicationId: "00000000-0000-4000-8000-000000000001",
  bucketStart: "2026-07-16T00:00:00.000Z",
  bucketSize: "hour",
  virtualModel: "text.fast",
  modelId: "model-1",
  requestModel: "openai-primary",
  provider: "openai",
  userId: "user_hmac:0123456789abcdef",
};

const metrics: ReconciliationMetrics = {
  eventCount: "1",
  inputTokens: "10",
  cachedInputTokens: "0",
  outputTokens: "3",
  providerCost: "0.1",
  aiuMicros: "100",
  unpricedCount: "0",
  unratedCount: "0",
};

describe("Prisma reconciliation persistence mapping", () => {
  it("round-trips exact snake-case dimensions and metrics", () => {
    const storedDimensions = persistedDimensions(dimensions);
    const storedMetrics = persistedMetrics(metrics);

    expect(storedDimensions).toEqual({
      application_id: dimensions.applicationId,
      granularity: "hour",
      time_bucket: dimensions.bucketStart,
      virtual_model: "text.fast",
      model_id: "model-1",
      request_model: "openai-primary",
      provider: "openai",
      user_id: "user_hmac:0123456789abcdef",
    });
    expect(storedMetrics).toMatchObject({
      event_count: "1",
      provider_cost: "0.1",
      aiu_micros: "100",
    });
    expect(storedMetrics).not.toHaveProperty("eventCount");
    expect(restoredDimensions(storedDimensions)).toEqual(dimensions);
    expect(restoredMetrics(storedMetrics)).toEqual(metrics);
  });

  it("uses SQL nulls and permits an empty delta for non-metric differences", () => {
    const diff: ReconciliationDiff = {
      type: "CH_MISSING",
      severity: "error",
      dimensions,
      pgValues: metrics,
      chValues: null,
      deltaValues: {},
      sampleEventIds: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"],
      count: "1",
      amount: null,
      explanation: "ClickHouse is missing the official aggregate.",
    };

    const stored = toPersistedDiff(diff);
    expect(stored.chValuesJson).toBe(Prisma.DbNull);
    expect(stored.deltaValuesJson).toEqual({});
    expect(stored.dimensionsJson).not.toHaveProperty("bucketStart");
  });
});

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  ApiErrorDto,
  BatchIngestionResponseDto,
  ConnectorHeartbeatDto,
  UsageBatchDto,
  UsageEventDto,
} from "../src/dtos.js";
import {
  apiErrorSchema,
  batchIngestionResponseSchema,
  connectorHeartbeatSchema,
} from "../src/machine-contracts.js";
import {
  usageConfidenceSchema,
  usageConfidenceValues,
  usageTypeSchema,
  usageTypeValues,
} from "../src/primitives.js";
import { usageBatchSchema, usageEventSchema } from "../src/usage-event.js";

const fixtures = new URL("../../../fixtures/contracts/current/", import.meta.url);

async function loadFixture(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(relativePath, fixtures), "utf8"));
}

describe.each([
  [
    "Connector Heartbeat",
    connectorHeartbeatSchema,
    "valid/connector-heartbeat.json",
    "invalid/heartbeat-negative-buffer.json",
  ],
  [
    "Batch Ingestion Response",
    batchIngestionResponseSchema,
    "valid/batch-ingestion-response.json",
    "invalid/batch-error-count-mismatch.json",
  ],
  [
    "API Error",
    apiErrorSchema,
    "valid/api-error.json",
    "invalid/api-error-sensitive-extra-field.json",
  ],
] as const)("%s", (_name, schema, validFixture, invalidFixture) => {
  it("accepts its canonical fixture", async () => {
    expect(schema.safeParse(await loadFixture(validFixture)).success).toBe(true);
  });

  it("rejects its invalid fixture", async () => {
    expect(schema.safeParse(await loadFixture(invalidFixture)).success).toBe(false);
  });
});

describe("usage classifications", () => {
  it("accepts every canonical usage type", () => {
    for (const usageType of usageTypeValues) {
      expect(usageTypeSchema.safeParse(usageType).success).toBe(true);
    }
    expect(usageTypeSchema.safeParse("custom:gpu_millisecond").success).toBe(false);
    expect(usageTypeSchema.safeParse("unknown_bucket").success).toBe(false);
  });

  it("accepts every canonical confidence value", () => {
    for (const confidence of usageConfidenceValues) {
      expect(usageConfidenceSchema.safeParse(confidence).success).toBe(true);
    }
    expect(usageConfidenceSchema.safeParse("guessed").success).toBe(false);
  });
});

describe("OpenAPI DTOs", () => {
  it.each([
    [UsageEventDto, usageEventSchema],
    [UsageBatchDto, usageBatchSchema],
    [ConnectorHeartbeatDto, connectorHeartbeatSchema],
    [BatchIngestionResponseDto, batchIngestionResponseSchema],
    [ApiErrorDto, apiErrorSchema],
  ])("uses the canonical Zod schema", (dto, schema) => {
    expect(dto.schema).toBe(schema);
  });
});

describe("generated artifacts", () => {
  it.each([
    "usage-event.schema.json",
    "usage-batch.schema.json",
    "connector-heartbeat.schema.json",
    "batch-ingestion-response.schema.json",
    "api-error.schema.json",
    "usage-type.schema.json",
    "usage-confidence.schema.json",
  ])("contains a stable schema ID in %s", async (fileName) => {
    const generated = JSON.parse(
      await readFile(new URL(`../generated/${fileName}`, import.meta.url), "utf8"),
    ) as { $id?: string };
    expect(generated.$id).toMatch(/^https:\/\/tokenpilot\.dev\/schemas\//);
  });
});

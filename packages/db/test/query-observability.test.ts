import { describe, expect, it, vi } from "vitest";

import {
  executeObservedDatabaseQuery,
  normalizeDatabaseQueryModel,
  normalizeDatabaseQueryOperation,
  type DatabaseQueryObservation,
} from "../src/query-observability.js";

describe("database query observability", () => {
  it("records only normalized, low-cardinality query metadata", async () => {
    const observations: DatabaseQueryObservation[] = [];
    const timestamps = [1_000_000_000n, 1_250_000_000n];
    let timestampIndex = 0;

    await expect(
      executeObservedDatabaseQuery(
        {
          model: "ApplicationUsageRating",
          operation: "findMany",
          execute: () => Promise.resolve("result"),
        },
        (observation) => observations.push(observation),
        () => timestamps[timestampIndex++] ?? timestamps.at(-1)!,
      ),
    ).resolves.toBe("result");

    expect(observations).toEqual([
      {
        model: "ApplicationUsageRating",
        operation: "read_many",
        outcome: "success",
        durationSeconds: 0.25,
      },
    ]);
  });

  it("propagates query failures without exposing errors, SQL, or parameters", async () => {
    const observations: DatabaseQueryObservation[] = [];
    const failure = new Error("SELECT secret FROM credentials WHERE token = 'PARAM_SENTINEL'");

    await expect(
      executeObservedDatabaseQuery(
        {
          model: undefined,
          operation: "$queryRaw",
          execute: () => Promise.reject(failure),
        },
        (observation) => observations.push(observation),
      ),
    ).rejects.toBe(failure);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      model: "raw",
      operation: "raw_read",
      outcome: "error",
    });
    const serialized = JSON.stringify(observations);
    expect(serialized).not.toContain("SELECT secret");
    expect(serialized).not.toContain("PARAM_SENTINEL");
  });

  it("does not let a telemetry failure alter the query result", async () => {
    const observer = vi.fn(() => {
      throw new Error("METRICS_BACKEND_SENTINEL");
    });

    await expect(
      executeObservedDatabaseQuery(
        {
          model: "AuditLog",
          operation: "create",
          execute: () => Promise.resolve(42),
        },
        observer,
      ),
    ).resolves.toBe(42);
    expect(observer).toHaveBeenCalledOnce();
  });

  it("bounds unexpected model and operation labels", () => {
    expect(normalizeDatabaseQueryModel("tenant-controlled-model")).toBe("unknown");
    expect(normalizeDatabaseQueryOperation("tenant-controlled-operation")).toBe("other");
    expect(normalizeDatabaseQueryOperation("executeRaw")).toBe("raw_write");
  });
});

import { describe, expect, it } from "vitest";

import { requiredDatastoreHealth } from "../features/shared/required-datastores.js";

describe("required datastore health", () => {
  it("is ready only when PostgreSQL, ClickHouse, and Redis are all healthy", () => {
    expect(
      requiredDatastoreHealth({
        status: "ready",
        dependencies: { postgres: "healthy", clickhouse: "healthy", redis: "healthy" },
      }),
    ).toEqual({ postgres: "healthy", clickhouse: "healthy", redis: "healthy", ready: true });
    expect(
      requiredDatastoreHealth({
        status: "ready",
        dependencies: {
          postgres: "healthy",
          clickhouse: "unavailable",
          redis: "healthy",
        },
      }).ready,
    ).toBe(false);
    expect(
      requiredDatastoreHealth({
        status: "ready",
        dependencies: {
          postgres: "healthy",
          clickhouse: "healthy",
          redis: "unavailable",
        },
      }).ready,
    ).toBe(false);
  });

  it("does not infer datastore health from a top-level ready value", () => {
    expect(requiredDatastoreHealth({ status: "ready" })).toEqual({
      postgres: "unknown",
      clickhouse: "unknown",
      redis: "unknown",
      ready: false,
    });
  });
});

import { describe, expect, it } from "vitest";

import { classifyPipelineError } from "../../src/pipeline/errors.js";

describe("pipeline error classification", () => {
  it("retries a PostgreSQL serialization failure wrapped by Prisma P2010", () => {
    const failure = classifyPipelineError(
      Object.assign(new Error("Raw query failed"), {
        code: "P2010",
        meta: { code: "40001", message: "database detail" },
      }),
      "quota_settled",
    );

    expect(failure).toMatchObject({ code: "40001", retryable: true });
  });

  it("retries the nested driver-adapter envelope used by Prisma's client engine", () => {
    const failure = classifyPipelineError(
      Object.assign(new Error("Raw query failed"), {
        code: "P2010",
        meta: {
          driverAdapterError: {
            name: "DriverAdapterError",
            cause: {
              kind: "postgres",
              originalCode: "40001",
              originalMessage: "could not serialize access",
            },
          },
        },
      }),
      "quota_settled",
    );

    expect(failure).toMatchObject({ code: "40001", retryable: true });
  });

  it("keeps a non-transient raw query error permanent", () => {
    const failure = classifyPipelineError(
      Object.assign(new Error("Raw query failed"), {
        code: "P2010",
        meta: { code: "42601", message: "database detail" },
      }),
      "quota_settled",
    );

    expect(failure).toMatchObject({ code: "P2010", retryable: false });
  });
});

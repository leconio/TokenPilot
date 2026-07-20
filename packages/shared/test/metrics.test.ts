import { describe, expect, it } from "vitest";

import {
  assertOperationalMetricContracts,
  OPERATIONAL_METRICS,
  sanitizeOperationalAttributes,
} from "../src/metrics.js";

describe("operational metric contracts", () => {
  it("uses unique low-cardinality labels", () => {
    expect(() => assertOperationalMetricContracts()).not.toThrow();
    expect(Object.values(OPERATIONAL_METRICS)).toHaveLength(39);
    expect(Object.values(OPERATIONAL_METRICS).flatMap((metric) => metric.labels)).not.toContain(
      "subject_id",
    );
  });

  it("rejects correlation IDs as labels", () => {
    expect(() =>
      assertOperationalMetricContracts({
        unsafe: { name: "ai_control_unsafe_total", kind: "counter", labels: ["request_id"] },
      }),
    ).toThrow(/unsafe metric label/u);
  });

  it("removes raw subjects and content while retaining bounded operational fields", () => {
    expect(
      sanitizeOperationalAttributes({
        subject_id: "customer-1",
        subject_hash: "sha256:abc",
        prompt: "private content",
        api_key: "secret-key",
        queue: "settlement",
        payload: { nested: true },
      }),
    ).toEqual({
      subject_hash: "sha256:abc",
      prompt: "[OMITTED]",
      api_key: "[REDACTED]",
      queue: "settlement",
      payload: "[OBJECT]",
    });
  });
});

import { describe, expect, it } from "vitest";

import { runtimeConfigurationAcknowledgementSchema } from "../src/index.js";

const acknowledgement = {
  schema_version: "2.0",
  application_id: "00000000-0000-4000-8000-000000000701",
  acknowledgement_id: "01J2QZ8V2H6Y0Y9W6Z42V97X3F",
  acknowledged_at: "2026-07-18T08:00:00.000Z",
  connector: { instance_id: "orders-api", name: "node", version: "0.2.0" },
  configuration_version: 7,
  configuration_etag: `sha256:${"a".repeat(64)}`,
  state: "applied",
  applied_at: "2026-07-18T08:00:00.000Z",
  error: null,
} as const;

describe("Runtime Configuration Acknowledgement", () => {
  it("accepts a connector applying one application configuration", () => {
    expect(runtimeConfigurationAcknowledgementSchema.parse(acknowledgement)).toEqual(
      acknowledgement,
    );
  });

  it("requires state-consistent timestamps and errors", () => {
    expect(
      runtimeConfigurationAcknowledgementSchema.safeParse({
        ...acknowledgement,
        state: "rejected",
        applied_at: null,
      }).success,
    ).toBe(false);
    expect(
      runtimeConfigurationAcknowledgementSchema.safeParse({
        ...acknowledgement,
        state: "received",
      }).success,
    ).toBe(false);
    expect(
      runtimeConfigurationAcknowledgementSchema.safeParse({
        ...acknowledgement,
        acknowledged_at: "2026-07-18T07:59:59.000Z",
      }).success,
    ).toBe(false);
  });
});

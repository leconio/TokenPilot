import { describe, expect, it } from "vitest";
import { Gauge, Registry } from "prom-client";

import { createOpenMetricsRegistry } from "../src/metrics.controller.js";
import { calculateRuntimeConfigurationAcknowledgementMetrics } from "../src/metrics/runtime-configuration-acknowledgement.js";

const publishedConfigurations = [
  { applicationId: "orders-id", applicationSlug: "orders", version: 7 },
  { applicationId: "support-id", applicationSlug: "support", version: 3 },
] as const;

describe("runtime configuration acknowledgement metrics", () => {
  it("emits an application-scoped no-ack state for every published configuration", () => {
    expect(
      calculateRuntimeConfigurationAcknowledgementMetrics(publishedConfigurations, []),
    ).toEqual({
      applicationStates: [
        {
          applicationId: "orders-id",
          applicationSlug: "orders",
          acknowledgementsAbsent: 1,
        },
        {
          applicationId: "support-id",
          applicationSlug: "support",
          acknowledgementsAbsent: 1,
        },
      ],
      connectorLags: [],
    });
  });

  it("keeps connector lag and acknowledgement presence isolated by application", () => {
    expect(
      calculateRuntimeConfigurationAcknowledgementMetrics(publishedConfigurations, [
        {
          applicationId: "orders-id",
          connectorInstanceId: "shared-connector",
          connectorName: "litellm",
          configurationVersion: 7,
          state: "APPLIED",
        },
        {
          applicationId: "support-id",
          connectorInstanceId: "shared-connector",
          connectorName: "litellm",
          configurationVersion: 3,
          state: "REJECTED",
        },
        {
          applicationId: "support-id",
          connectorInstanceId: "shared-connector",
          connectorName: "litellm",
          configurationVersion: 2,
          state: "APPLIED",
        },
        {
          applicationId: "retired-application-id",
          connectorInstanceId: "ignored",
          connectorName: "litellm",
          configurationVersion: 99,
          state: "APPLIED",
        },
      ]),
    ).toEqual({
      applicationStates: [
        {
          applicationId: "orders-id",
          applicationSlug: "orders",
          acknowledgementsAbsent: 0,
        },
        {
          applicationId: "support-id",
          applicationSlug: "support",
          acknowledgementsAbsent: 0,
        },
      ],
      connectorLags: [
        {
          applicationId: "orders-id",
          applicationSlug: "orders",
          connectorInstanceId: "shared-connector",
          connectorName: "litellm",
          lag: 0,
        },
        {
          applicationId: "support-id",
          applicationSlug: "support",
          connectorInstanceId: "shared-connector",
          connectorName: "litellm",
          lag: 1,
        },
      ],
    });
  });

  it("does not expose acknowledgement series without a current published configuration", () => {
    expect(
      calculateRuntimeConfigurationAcknowledgementMetrics(
        [],
        [
          {
            applicationId: "retired-application-id",
            connectorInstanceId: "connector",
            connectorName: "litellm",
            configurationVersion: 4,
            state: "APPLIED",
          },
        ],
      ),
    ).toEqual({
      applicationStates: [],
      connectorLags: [],
    });
  });
});

describe("API metrics exposition", () => {
  it("renders the OpenMetrics content type with the required EOF marker", async () => {
    const registry = createOpenMetricsRegistry();
    const ready = new Gauge({
      name: "ai_control_test_ready",
      help: "Test-only readiness metric.",
      registers: [registry],
    });
    ready.set(1);

    expect(registry.contentType).toBe(Registry.OPENMETRICS_CONTENT_TYPE);
    expect(await registry.metrics()).toMatch(/# EOF\n$/u);
  });
});

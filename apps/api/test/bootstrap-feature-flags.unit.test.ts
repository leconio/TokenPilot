import { describe, expect, it, vi } from "vitest";

import { DeploymentEnvironment, type DatabaseClient } from "@tokenpilot/db";
import {
  InvalidInstanceFeatureConfigurationError,
  SAFE_INSTANCE_FEATURE_RUNTIME_PREREQUISITES,
} from "@tokenpilot/shared";

import type { ApiConfiguration } from "../src/api-config.js";
import { MachineConfigurationBootstrap } from "../src/bootstrap.service.js";

describe("API feature configuration bootstrap", () => {
  it("fails closed before syncing credentials when persisted flags lack runtime prerequisites", async () => {
    const serviceApiKeyUpsert = vi.fn();
    const database = {
      instanceSettings: {
        upsert: vi.fn().mockResolvedValue({
          id: 1,
          instanceId: "bootstrap-test-01",
          environment: DeploymentEnvironment.TEST,
          timezone: "UTC",
          baseCurrency: "USD",
          featureUsagePipeline: false,
          featureModelCatalog: false,
          featureAiu: true,
          featureQuota: false,
          featureHardLimit: false,
          featureReconciliation: false,
          aiuMicroScale: 1_000_000n,
          createdAt: new Date("2026-07-16T00:00:00Z"),
          updatedAt: new Date("2026-07-16T00:00:00Z"),
        }),
      },
      serviceApiKey: { upsert: serviceApiKeyUpsert },
    } as unknown as DatabaseClient;
    const configuration = {
      instanceId: "bootstrap-test-01",
      environment: "test",
      timezone: "UTC",
      baseCurrency: "USD",
      featureRuntimePrerequisites: SAFE_INSTANCE_FEATURE_RUNTIME_PREREQUISITES,
      apiKeyPepper: "bootstrap-api-key-pepper-000000000001",
    } as unknown as ApiConfiguration;

    await expect(
      new MachineConfigurationBootstrap(database, configuration).onApplicationBootstrap(),
    ).rejects.toBeInstanceOf(InvalidInstanceFeatureConfigurationError);
    expect(serviceApiKeyUpsert).not.toHaveBeenCalled();
  });

  it("does not create deployment-wide credentials", async () => {
    const serviceApiKeyUpsert = vi.fn().mockResolvedValue({ id: "configured-key" });
    const database = {
      instanceSettings: {
        upsert: vi.fn().mockResolvedValue({
          id: 1,
          instanceId: "bootstrap-test-01",
          environment: DeploymentEnvironment.TEST,
          timezone: "UTC",
          baseCurrency: "USD",
          featureUsagePipeline: false,
          featureModelCatalog: false,
          featureAiu: false,
          featureQuota: false,
          featureHardLimit: false,
          featureReconciliation: false,
          aiuMicroScale: 1_000_000n,
        }),
      },
      serviceApiKey: { upsert: serviceApiKeyUpsert },
    } as unknown as DatabaseClient;
    const configuration = {
      instanceId: "bootstrap-test-01",
      environment: "test",
      timezone: "UTC",
      baseCurrency: "USD",
      featureRuntimePrerequisites: SAFE_INSTANCE_FEATURE_RUNTIME_PREREQUISITES,
      apiKeyPepper: "bootstrap-api-key-pepper-000000000001",
    } as unknown as ApiConfiguration;

    await new MachineConfigurationBootstrap(database, configuration).onApplicationBootstrap();

    expect(serviceApiKeyUpsert).not.toHaveBeenCalled();
  });
});

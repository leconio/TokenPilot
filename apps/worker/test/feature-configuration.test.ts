import { describe, expect, it, vi } from "vitest";

import {
  DeploymentEnvironment,
  ImmutableInstanceSettingMismatchError,
  InstanceSettingsNotInitializedError,
  type DatabaseClient,
} from "@tokenpilot/db";
import { SAFE_INSTANCE_FEATURE_RUNTIME_PREREQUISITES } from "@tokenpilot/shared";

import { loadValidatedWorkerFeatureFlags } from "../src/feature-configuration.js";

function settings(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: 1,
    instanceId: "worker-feature-test-01",
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
    createdAt: new Date("2026-07-16T00:00:00Z"),
    updatedAt: new Date("2026-07-16T00:00:00Z"),
    ...overrides,
  };
}

function databaseWith(row: ReturnType<typeof settings> | null): DatabaseClient {
  return {
    instanceSettings: { findUnique: vi.fn().mockResolvedValue(row) },
  } as unknown as DatabaseClient;
}

describe("Worker persisted feature configuration", () => {
  it("fails closed when API bootstrap has not created instance_settings", async () => {
    await expect(
      loadValidatedWorkerFeatureFlags(
        databaseWith(null),
        SAFE_INSTANCE_FEATURE_RUNTIME_PREREQUISITES,
        1_000_000,
      ),
    ).rejects.toBeInstanceOf(InstanceSettingsNotInitializedError);
  });

  it("loads a valid observe-mode Quota configuration without enabling settlement itself", async () => {
    await expect(
      loadValidatedWorkerFeatureFlags(
        databaseWith(settings({ featureAiu: true, featureQuota: true })),
        {
          ...SAFE_INSTANCE_FEATURE_RUNTIME_PREREQUISITES,
          aiuEnabled: true,
          aiuMode: "observe",
        },
        1_000_000,
      ),
    ).resolves.toMatchObject({ aiu: true, quota: true });
  });

  it("fails closed when the persisted AIU micro-scale differs from Worker configuration", async () => {
    await expect(
      loadValidatedWorkerFeatureFlags(
        databaseWith(settings({ aiuMicroScale: 2_000_000n })),
        SAFE_INSTANCE_FEATURE_RUNTIME_PREREQUISITES,
        1_000_000,
      ),
    ).rejects.toBeInstanceOf(ImmutableInstanceSettingMismatchError);
  });
});

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_INSTANCE_FEATURE_FLAGS, type InstanceFeatureFlags } from "@tokenpilot/shared";

import type { DatabaseClient } from "../src/client.js";
import { DeploymentEnvironment } from "../src/generated/prisma/enums.js";
import {
  ensureInstanceSettings,
  ImmutableInstanceSettingMismatchError,
  InstanceIdentityMismatchError,
  InstanceSettingsNotInitializedError,
  readInstanceFeatureFlags,
} from "../src/instance-settings.js";

const identity = {
  instanceId: "feature-test-01",
  environment: "test" as const,
  timezone: "UTC",
  baseCurrency: "USD",
};

function settings(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: 1,
    instanceId: identity.instanceId,
    environment: DeploymentEnvironment.TEST,
    timezone: identity.timezone,
    baseCurrency: identity.baseCurrency,
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

function databaseWith(row: ReturnType<typeof settings> | null) {
  const upsert = vi.fn().mockResolvedValue(row);
  const findUnique = vi.fn().mockResolvedValue(row);
  return {
    database: { instanceSettings: { upsert, findUnique } } as unknown as DatabaseClient,
    upsert,
    findUnique,
  };
}

describe("instance feature settings", () => {
  it("uses environment flags only when creating the singleton row", async () => {
    const persisted = settings();
    const { database, upsert } = databaseWith(persisted);
    const requested: InstanceFeatureFlags = {
      usage_pipeline: true,
      model_catalog: true,
      aiu: true,
      quota: true,
      hard_limit: true,
      reconciliation: true,
    };

    await expect(
      ensureInstanceSettings(database, { ...identity, featureFlagDefaults: requested }),
    ).resolves.toEqual(DEFAULT_INSTANCE_FEATURE_FLAGS);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          featureUsagePipeline: true,
          featureModelCatalog: true,
          featureAiu: true,
          featureQuota: true,
          featureHardLimit: true,
          featureReconciliation: true,
        }),
        update: {},
      }),
    );
  });

  it("reads PostgreSQL flags instead of later environment defaults", async () => {
    const persisted = settings({ featureUsagePipeline: true });
    const { database } = databaseWith(persisted);

    await expect(readInstanceFeatureFlags(database)).resolves.toEqual({
      ...DEFAULT_INSTANCE_FEATURE_FLAGS,
      usage_pipeline: true,
    });
  });

  it("fails closed before first-instance bootstrap", async () => {
    const { database } = databaseWith(null);
    await expect(readInstanceFeatureFlags(database)).rejects.toBeInstanceOf(
      InstanceSettingsNotInitializedError,
    );
  });

  it("rejects identity drift and AIU micro-scale drift without exposing values", async () => {
    const identityDatabase = databaseWith(settings({ instanceId: "another-instance" })).database;
    await expect(ensureInstanceSettings(identityDatabase, identity)).rejects.toBeInstanceOf(
      InstanceIdentityMismatchError,
    );

    const scaleDatabase = databaseWith(settings({ aiuMicroScale: 2_000_000n })).database;
    await expect(
      ensureInstanceSettings(scaleDatabase, { ...identity, aiuMicroScale: 1_000_000 }),
    ).rejects.toBeInstanceOf(ImmutableInstanceSettingMismatchError);
  });
});

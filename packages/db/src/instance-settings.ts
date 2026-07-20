import type { DatabaseClient } from "./client.js";
import { DeploymentEnvironment } from "./generated/prisma/enums.js";
import { DEFAULT_INSTANCE_FEATURE_FLAGS, type InstanceFeatureFlags } from "@tokenpilot/shared";

export interface InstanceIdentity {
  readonly instanceId: string;
  readonly environment: "development" | "test" | "staging" | "production";
  readonly timezone: string;
  readonly baseCurrency: string;
}

export interface InstanceBootstrapSettings extends InstanceIdentity {
  readonly featureFlagDefaults?: InstanceFeatureFlags;
  readonly aiuMicroScale?: number | bigint;
}

export interface InstanceFeatureConfiguration {
  readonly flags: InstanceFeatureFlags;
  readonly aiuMicroScale: bigint;
}

export class InstanceIdentityMismatchError extends Error {
  readonly code = "INSTANCE_IDENTITY_MISMATCH";

  constructor(readonly mismatchedFields: readonly string[]) {
    super(`Database instance identity does not match environment: ${mismatchedFields.join(", ")}`);
    this.name = "InstanceIdentityMismatchError";
  }
}

export class ImmutableInstanceSettingMismatchError extends Error {
  readonly code = "IMMUTABLE_INSTANCE_SETTING_MISMATCH";

  constructor(readonly field: "AIU_MICRO_SCALE") {
    super(`Database immutable instance setting does not match environment: ${field}`);
    this.name = "ImmutableInstanceSettingMismatchError";
  }
}

export class InstanceSettingsNotInitializedError extends Error {
  readonly code = "INSTANCE_SETTINGS_NOT_INITIALIZED";

  constructor() {
    super("Instance settings have not been initialized by the API bootstrap");
    this.name = "InstanceSettingsNotInitializedError";
  }
}

const environmentValues: Readonly<Record<InstanceIdentity["environment"], DeploymentEnvironment>> =
  {
    development: DeploymentEnvironment.DEVELOPMENT,
    test: DeploymentEnvironment.TEST,
    staging: DeploymentEnvironment.STAGING,
    production: DeploymentEnvironment.PRODUCTION,
  };

export async function ensureInstanceSettings(
  database: DatabaseClient,
  expected: InstanceBootstrapSettings,
): Promise<InstanceFeatureFlags> {
  const featureFlags = expected.featureFlagDefaults ?? DEFAULT_INSTANCE_FEATURE_FLAGS;
  const aiuMicroScale = BigInt(expected.aiuMicroScale ?? 1_000_000);
  const settings = await database.instanceSettings.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      instanceId: expected.instanceId,
      environment: environmentValues[expected.environment],
      timezone: expected.timezone,
      baseCurrency: expected.baseCurrency,
      featureUsagePipeline: featureFlags.usage_pipeline,
      featureModelCatalog: featureFlags.model_catalog,
      featureAiu: featureFlags.aiu,
      featureQuota: featureFlags.quota,
      featureHardLimit: featureFlags.hard_limit,
      featureReconciliation: featureFlags.reconciliation,
      aiuMicroScale,
    },
    update: {},
  });

  const mismatchedFields = [
    settings.instanceId === expected.instanceId ? undefined : "INSTANCE_ID",
    settings.environment === environmentValues[expected.environment] ? undefined : "ENVIRONMENT",
    settings.timezone === expected.timezone ? undefined : "APP_TIMEZONE",
    settings.baseCurrency === expected.baseCurrency ? undefined : "BASE_CURRENCY",
  ].filter((field): field is string => field !== undefined);

  if (mismatchedFields.length > 0) {
    throw new InstanceIdentityMismatchError(mismatchedFields);
  }
  if (settings.aiuMicroScale !== aiuMicroScale) {
    throw new ImmutableInstanceSettingMismatchError("AIU_MICRO_SCALE");
  }

  return instanceFeatureFlagsFromSettings(settings);
}

export function instanceFeatureFlagsFromSettings(settings: {
  readonly featureUsagePipeline: boolean;
  readonly featureModelCatalog: boolean;
  readonly featureAiu: boolean;
  readonly featureQuota: boolean;
  readonly featureHardLimit: boolean;
  readonly featureReconciliation: boolean;
}): InstanceFeatureFlags {
  return Object.freeze({
    usage_pipeline: settings.featureUsagePipeline,
    model_catalog: settings.featureModelCatalog,
    aiu: settings.featureAiu,
    quota: settings.featureQuota,
    hard_limit: settings.featureHardLimit,
    reconciliation: settings.featureReconciliation,
  });
}

export async function readInstanceFeatureFlags(
  database: DatabaseClient,
): Promise<InstanceFeatureFlags> {
  return (await readInstanceFeatureConfiguration(database)).flags;
}

export async function readInstanceFeatureConfiguration(
  database: DatabaseClient,
): Promise<InstanceFeatureConfiguration> {
  const settings = await database.instanceSettings.findUnique({ where: { id: 1 } });
  if (settings === null) throw new InstanceSettingsNotInitializedError();
  return Object.freeze({
    flags: instanceFeatureFlagsFromSettings(settings),
    aiuMicroScale: settings.aiuMicroScale,
  });
}

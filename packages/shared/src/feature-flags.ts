export const INSTANCE_FEATURE_FLAG_NAMES = [
  "usage_pipeline",
  "model_catalog",
  "aiu",
  "quota",
  "hard_limit",
  "reconciliation",
] as const;

export type InstanceFeatureFlagName = (typeof INSTANCE_FEATURE_FLAG_NAMES)[number];
export type InstanceFeatureFlags = Readonly<Record<InstanceFeatureFlagName, boolean>>;

export const AIU_MODES = ["disabled", "observe", "soft_limit", "hard_limit"] as const;
export type AiuMode = (typeof AIU_MODES)[number];

export interface InstanceFeatureRuntimePrerequisites {
  readonly aiuEnabled: boolean;
  readonly aiuMode: AiuMode;
  readonly reconciliationHourlyEnabled: boolean;
  readonly reconciliationDailyEnabled: boolean;
}

export const SAFE_INSTANCE_FEATURE_RUNTIME_PREREQUISITES: InstanceFeatureRuntimePrerequisites =
  Object.freeze({
    aiuEnabled: false,
    aiuMode: "disabled",
    reconciliationHourlyEnabled: false,
    reconciliationDailyEnabled: false,
  });

export const FEATURE_FLAG_ENVIRONMENT_KEYS = {
  usage_pipeline: "FEATURE_USAGE_PIPELINE",
  model_catalog: "FEATURE_MODEL_CATALOG",
  aiu: "FEATURE_AIU",
  quota: "FEATURE_QUOTA",
  hard_limit: "FEATURE_HARD_LIMIT",
  reconciliation: "FEATURE_RECONCILIATION",
} as const satisfies Readonly<Record<InstanceFeatureFlagName, string>>;

export type FeatureFlagEnvironmentKey =
  (typeof FEATURE_FLAG_ENVIRONMENT_KEYS)[InstanceFeatureFlagName];

type FeatureRuntimeEnvironment = Readonly<{
  AIU_ENABLED: boolean;
  AIU_MODE: AiuMode;
  RECONCILIATION_HOURLY_ENABLED: boolean;
  RECONCILIATION_DAILY_ENABLED: boolean;
}>;

export class InvalidInstanceFeatureConfigurationError extends Error {
  readonly code = "INVALID_INSTANCE_FEATURE_CONFIGURATION";

  constructor(readonly issues: readonly string[]) {
    super(`Invalid instance feature configuration: ${issues.join("; ")}`);
    this.name = "InvalidInstanceFeatureConfigurationError";
  }
}

export const DEFAULT_INSTANCE_FEATURE_FLAGS: InstanceFeatureFlags = Object.freeze({
  usage_pipeline: false,
  model_catalog: false,
  aiu: false,
  quota: false,
  hard_limit: false,
  reconciliation: false,
});

export function featureFlagsFromEnvironment(
  environment: Readonly<Record<FeatureFlagEnvironmentKey, boolean>>,
): InstanceFeatureFlags {
  return Object.freeze(
    Object.fromEntries(
      INSTANCE_FEATURE_FLAG_NAMES.map((name) => [
        name,
        environment[FEATURE_FLAG_ENVIRONMENT_KEYS[name]],
      ]),
    ),
  ) as InstanceFeatureFlags;
}

export function enabledFeatureCapabilities(
  flags: InstanceFeatureFlags,
): readonly InstanceFeatureFlagName[] {
  return INSTANCE_FEATURE_FLAG_NAMES.filter((name) => flags[name]);
}

export function featureRuntimePrerequisitesFromEnvironment(
  environment: FeatureRuntimeEnvironment,
): InstanceFeatureRuntimePrerequisites {
  return Object.freeze({
    aiuEnabled: environment.AIU_ENABLED,
    aiuMode: environment.AIU_MODE,
    reconciliationHourlyEnabled: environment.RECONCILIATION_HOURLY_ENABLED,
    reconciliationDailyEnabled: environment.RECONCILIATION_DAILY_ENABLED,
  });
}

export function instanceFeatureConfigurationIssues(
  flags: InstanceFeatureFlags,
  runtime: InstanceFeatureRuntimePrerequisites,
): readonly string[] {
  const issues: string[] = [];
  if (flags.quota && !flags.aiu) {
    issues.push("quota requires aiu");
  }
  if (flags.hard_limit && (!flags.aiu || !flags.quota)) {
    issues.push("hard_limit requires aiu and quota");
  }
  if (flags.aiu && (!runtime.aiuEnabled || runtime.aiuMode === "disabled")) {
    issues.push("aiu requires AIU_ENABLED=true and an active AIU_MODE");
  }
  if (flags.hard_limit && runtime.aiuMode !== "hard_limit") {
    issues.push("hard_limit requires AIU_MODE=hard_limit");
  }
  if (
    flags.reconciliation &&
    !runtime.reconciliationHourlyEnabled &&
    !runtime.reconciliationDailyEnabled
  ) {
    issues.push("reconciliation requires at least one enabled schedule");
  }
  if (runtime.aiuEnabled === (runtime.aiuMode === "disabled")) {
    issues.push("AIU_ENABLED and AIU_MODE are inconsistent");
  }
  return Object.freeze(issues);
}

export function assertValidInstanceFeatureConfiguration(
  flags: InstanceFeatureFlags,
  runtime: InstanceFeatureRuntimePrerequisites,
): void {
  const issues = instanceFeatureConfigurationIssues(flags, runtime);
  if (issues.length > 0) throw new InvalidInstanceFeatureConfigurationError(issues);
}

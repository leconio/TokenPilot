import { describe, expect, it } from "vitest";

import {
  assertValidInstanceFeatureConfiguration,
  DEFAULT_INSTANCE_FEATURE_FLAGS,
  enabledFeatureCapabilities,
  featureFlagsFromEnvironment,
  featureRuntimePrerequisitesFromEnvironment,
  instanceFeatureConfigurationIssues,
  InvalidInstanceFeatureConfigurationError,
  SAFE_INSTANCE_FEATURE_RUNTIME_PREREQUISITES,
} from "../src/feature-flags.js";

describe("instance feature flags", () => {
  it("keeps optional capabilities off by default", () => {
    expect(DEFAULT_INSTANCE_FEATURE_FLAGS).toEqual({
      usage_pipeline: false,
      model_catalog: false,
      aiu: false,
      quota: false,
      hard_limit: false,
      reconciliation: false,
    });
    expect(enabledFeatureCapabilities(DEFAULT_INSTANCE_FEATURE_FLAGS)).toEqual([]);
  });

  it("maps environment defaults without renaming or omitting a flag", () => {
    const flags = featureFlagsFromEnvironment({
      FEATURE_USAGE_PIPELINE: true,
      FEATURE_MODEL_CATALOG: true,
      FEATURE_AIU: true,
      FEATURE_QUOTA: false,
      FEATURE_HARD_LIMIT: false,
      FEATURE_RECONCILIATION: true,
    });

    expect(flags).toEqual({
      usage_pipeline: true,
      model_catalog: true,
      aiu: true,
      quota: false,
      hard_limit: false,
      reconciliation: true,
    });
    expect(enabledFeatureCapabilities(flags)).toEqual([
      "usage_pipeline",
      "model_catalog",
      "aiu",
      "reconciliation",
    ]);
  });

  it("fails closed when persisted flags have missing dependencies or runtime prerequisites", () => {
    const invalid = {
      ...DEFAULT_INSTANCE_FEATURE_FLAGS,
      aiu: true,
      quota: true,
      hard_limit: true,
      reconciliation: true,
    };
    const runtime = {
      ...SAFE_INSTANCE_FEATURE_RUNTIME_PREREQUISITES,
      reconciliationHourlyEnabled: false,
      reconciliationDailyEnabled: false,
    };

    expect(instanceFeatureConfigurationIssues(invalid, runtime)).toEqual([
      "aiu requires AIU_ENABLED=true and an active AIU_MODE",
      "hard_limit requires AIU_MODE=hard_limit",
      "reconciliation requires at least one enabled schedule",
    ]);
    expect(() => assertValidInstanceFeatureConfiguration(invalid, runtime)).toThrow(
      InvalidInstanceFeatureConfigurationError,
    );
  });

  it("rejects persisted AIU dependency inversions independently of environment defaults", () => {
    const issues = instanceFeatureConfigurationIssues(
      {
        ...DEFAULT_INSTANCE_FEATURE_FLAGS,
        quota: true,
        hard_limit: true,
      },
      SAFE_INSTANCE_FEATURE_RUNTIME_PREREQUISITES,
    );

    expect(issues).toContain("quota requires aiu");
    expect(issues).toContain("hard_limit requires aiu and quota");
  });

  it("allows staged Quota flags in observe mode while side-effect gates remain responsible", () => {
    const flags = {
      ...DEFAULT_INSTANCE_FEATURE_FLAGS,
      aiu: true,
      quota: true,
    };
    const runtime = featureRuntimePrerequisitesFromEnvironment({
      AIU_ENABLED: true,
      AIU_MODE: "observe",
      RECONCILIATION_HOURLY_ENABLED: true,
      RECONCILIATION_DAILY_ENABLED: true,
    });

    expect(() => assertValidInstanceFeatureConfiguration(flags, runtime)).not.toThrow();
  });

  it("accepts a fully satisfied effective configuration", () => {
    const flags = {
      ...DEFAULT_INSTANCE_FEATURE_FLAGS,
      aiu: true,
      quota: true,
      hard_limit: true,
      reconciliation: true,
    };
    const runtime = featureRuntimePrerequisitesFromEnvironment({
      AIU_ENABLED: true,
      AIU_MODE: "hard_limit",
      RECONCILIATION_HOURLY_ENABLED: false,
      RECONCILIATION_DAILY_ENABLED: true,
    });

    expect(() => assertValidInstanceFeatureConfiguration(flags, runtime)).not.toThrow();
  });
});

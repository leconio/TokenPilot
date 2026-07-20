import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";

import { ensureInstanceSettings, type DatabaseClient } from "@tokenpilot/db";
import {
  assertValidInstanceFeatureConfiguration,
  SAFE_INSTANCE_FEATURE_RUNTIME_PREREQUISITES,
} from "@tokenpilot/shared";

import type { ApiConfiguration } from "./api-config.js";
import { API_CONFIGURATION, DATABASE_CLIENT } from "./tokens.js";

@Injectable()
export class MachineConfigurationBootstrap implements OnApplicationBootstrap {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(API_CONFIGURATION) private readonly configuration: ApiConfiguration,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const featureFlags = await ensureInstanceSettings(this.database, {
      instanceId: this.configuration.instanceId,
      environment: this.configuration.environment,
      timezone: this.configuration.timezone,
      baseCurrency: this.configuration.baseCurrency,
      ...(this.configuration.featureFlagDefaults === undefined
        ? {}
        : { featureFlagDefaults: this.configuration.featureFlagDefaults }),
      ...(this.configuration.aiuMicroScale === undefined
        ? {}
        : { aiuMicroScale: this.configuration.aiuMicroScale }),
    });
    assertValidInstanceFeatureConfiguration(
      featureFlags,
      this.configuration.featureRuntimePrerequisites ?? SAFE_INSTANCE_FEATURE_RUNTIME_PREREQUISITES,
    );
  }
}

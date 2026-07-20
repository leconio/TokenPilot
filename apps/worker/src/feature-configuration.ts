import {
  ImmutableInstanceSettingMismatchError,
  readInstanceFeatureConfiguration,
  type DatabaseClient,
} from "@tokenpilot/db";
import {
  assertValidInstanceFeatureConfiguration,
  type InstanceFeatureFlags,
  type InstanceFeatureRuntimePrerequisites,
} from "@tokenpilot/shared";

export async function loadValidatedWorkerFeatureFlags(
  database: DatabaseClient,
  runtime: InstanceFeatureRuntimePrerequisites,
  expectedAiuMicroScale: number | bigint,
): Promise<InstanceFeatureFlags> {
  const configuration = await readInstanceFeatureConfiguration(database);
  if (configuration.aiuMicroScale !== BigInt(expectedAiuMicroScale)) {
    throw new ImmutableInstanceSettingMismatchError("AIU_MICRO_SCALE");
  }
  assertValidInstanceFeatureConfiguration(configuration.flags, runtime);
  return configuration.flags;
}

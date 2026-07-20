import {
  assertValidInstanceFeatureConfiguration,
  INSTANCE_FEATURE_FLAG_NAMES,
  type InstanceFeatureFlagName,
  type InstanceFeatureFlags,
  type InstanceFeatureRuntimePrerequisites,
} from "@tokenpilot/shared";

import type { DatabaseClient } from "./client.js";
import { Prisma } from "./generated/prisma/client.js";
import {
  instanceFeatureFlagsFromSettings,
  InstanceSettingsNotInitializedError,
} from "./instance-settings.js";

export type InstanceFeatureFlagPatch = Readonly<Partial<Record<InstanceFeatureFlagName, boolean>>>;

export interface SetInstanceFeatureFlagsInput {
  readonly patch: InstanceFeatureFlagPatch;
  readonly runtime: InstanceFeatureRuntimePrerequisites;
  readonly actorId: string;
  readonly reason: string;
}

export interface SetInstanceFeatureFlagsResult {
  readonly before: InstanceFeatureFlags;
  readonly after: InstanceFeatureFlags;
  readonly changedFlags: readonly InstanceFeatureFlagName[];
  readonly workerRestartRequired: boolean;
}

export class InvalidFeatureFlagUpdateError extends Error {
  readonly code = "INVALID_FEATURE_FLAG_UPDATE";

  constructor(message: string) {
    super(message);
    this.name = "InvalidFeatureFlagUpdateError";
  }
}

function validateOperatorMetadata(actorId: string, reason: string): void {
  const actorLength = actorId.trim().length;
  if (actorLength === 0 || actorLength > 256) {
    throw new InvalidFeatureFlagUpdateError(
      "Feature flag updates require an actor between 1 and 256 characters",
    );
  }
  const reasonLength = reason.trim().length;
  if (reasonLength < 5 || reasonLength > 500) {
    throw new InvalidFeatureFlagUpdateError(
      "Feature flag updates require a reason between 5 and 500 characters",
    );
  }
}

export async function setInstanceFeatureFlags(
  database: DatabaseClient,
  input: SetInstanceFeatureFlagsInput,
): Promise<SetInstanceFeatureFlagsResult> {
  validateOperatorMetadata(input.actorId, input.reason);
  const requestedFlags = INSTANCE_FEATURE_FLAG_NAMES.filter(
    (name) => input.patch[name] !== undefined,
  );
  if (requestedFlags.length === 0) {
    throw new InvalidFeatureFlagUpdateError("At least one feature flag assignment is required");
  }

  return database.$transaction(
    async (transaction) => {
      const current = await transaction.instanceSettings.findUnique({ where: { id: 1 } });
      if (current === null) throw new InstanceSettingsNotInitializedError();
      const before = instanceFeatureFlagsFromSettings(current);
      const after = Object.freeze({ ...before, ...input.patch }) as InstanceFeatureFlags;
      assertValidInstanceFeatureConfiguration(after, input.runtime);
      const changedFlags = requestedFlags.filter((name) => before[name] !== after[name]);
      if (changedFlags.length === 0) {
        return {
          before,
          after,
          changedFlags: Object.freeze([]),
          // The Worker consumes a startup snapshot and does not ACK a persisted
          // configuration revision yet. A no-op in PostgreSQL therefore cannot
          // prove that a running Worker already applied the desired value.
          workerRestartRequired: true,
        };
      }

      await transaction.instanceSettings.update({
        where: { id: 1 },
        data: {
          featureUsagePipeline: after.usage_pipeline,
          featureModelCatalog: after.model_catalog,
          featureAiu: after.aiu,
          featureQuota: after.quota,
          featureHardLimit: after.hard_limit,
          featureReconciliation: after.reconciliation,
        },
      });
      await transaction.auditLog.create({
        data: {
          actorId: input.actorId.trim(),
          action: "instance.feature_flags.set",
          objectType: "instance_settings",
          objectId: current.instanceId,
          beforeJson: { feature_flags: { ...before } },
          afterJson: {
            feature_flags: { ...after },
            changed_flags: changedFlags,
            worker_restart_required: true,
          },
          reason: input.reason.trim(),
        },
      });
      return {
        before,
        after,
        changedFlags: Object.freeze(changedFlags),
        workerRestartRequired: true,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

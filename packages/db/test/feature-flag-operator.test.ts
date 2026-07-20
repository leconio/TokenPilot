import { describe, expect, it, vi } from "vitest";

import {
  featureRuntimePrerequisitesFromEnvironment,
  InvalidInstanceFeatureConfigurationError,
  loadFeatureFlagOperatorEnvironment,
  SAFE_INSTANCE_FEATURE_RUNTIME_PREREQUISITES,
} from "@tokenpilot/shared";

import type { DatabaseClient } from "../src/client.js";
import { parseFeatureFlagCliCommand } from "../src/feature-flags-cli.js";
import { setInstanceFeatureFlags } from "../src/feature-flag-operator.js";
import { DeploymentEnvironment } from "../src/generated/prisma/enums.js";

function settings(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: 1,
    instanceId: "operator-test-01",
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

function databaseWith(row: ReturnType<typeof settings>) {
  const update = vi.fn().mockResolvedValue(row);
  const auditCreate = vi.fn().mockResolvedValue({ id: "audit-1" });
  const transactionClient = {
    instanceSettings: {
      findUnique: vi.fn().mockResolvedValue(row),
      update,
    },
    auditLog: { create: auditCreate },
  };
  const transaction = vi.fn(
    async (callback: (client: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
  );
  return {
    database: { $transaction: transaction } as unknown as DatabaseClient,
    update,
    auditCreate,
    transaction,
  };
}

describe("audited feature-flag operator", () => {
  it("parses an atomic multi-flag set command and rejects unsafe syntax", () => {
    expect(
      parseFeatureFlagCliCommand([
        "set",
        "aiu=true",
        "quota=true",
        "--actor",
        "operator:alice",
        "--reason",
        "Enable observe-mode rollout",
      ]),
    ).toEqual({
      kind: "set",
      patch: { aiu: true, quota: true },
      actorId: "operator:alice",
      reason: "Enable observe-mode rollout",
    });
    expect(() =>
      parseFeatureFlagCliCommand([
        "set",
        "unknown=true",
        "--actor",
        "operator:alice",
        "--reason",
        "Invalid flag",
      ]),
    ).toThrow(/Unknown feature flag/u);
    expect(() => parseFeatureFlagCliCommand(["set", "aiu=true"])).toThrow(/--actor/u);
  });

  it("updates flags and writes the audit record in one serializable transaction", async () => {
    const { database, update, auditCreate, transaction } = databaseWith(settings());
    const result = await setInstanceFeatureFlags(database, {
      patch: { aiu: true, quota: true },
      runtime: {
        ...SAFE_INSTANCE_FEATURE_RUNTIME_PREREQUISITES,
        aiuEnabled: true,
        aiuMode: "observe",
      },
      actorId: "operator:alice",
      reason: "Enable observe-mode quota preparation",
    });

    expect(result).toMatchObject({
      changedFlags: ["aiu", "quota"],
      workerRestartRequired: true,
      after: { aiu: true, quota: true },
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({ featureAiu: true, featureQuota: true }),
      }),
    );
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "operator:alice",
        action: "instance.feature_flags.set",
        objectType: "instance_settings",
        objectId: "operator-test-01",
        reason: "Enable observe-mode quota preparation",
        afterJson: expect.objectContaining({
          changed_flags: ["aiu", "quota"],
          worker_restart_required: true,
        }),
      }),
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
  });

  it("rejects invalid dependency changes before update or audit", async () => {
    const { database, update, auditCreate } = databaseWith(settings());
    await expect(
      setInstanceFeatureFlags(database, {
        patch: { quota: true },
        runtime: SAFE_INSTANCE_FEATURE_RUNTIME_PREREQUISITES,
        actorId: "operator:bob",
        reason: "Attempt invalid quota enable",
      }),
    ).rejects.toBeInstanceOf(InvalidInstanceFeatureConfigurationError);
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("conservatively requires a Worker restart for a no-op without an applied-revision ACK", async () => {
    const { database, update, auditCreate } = databaseWith(settings());
    await expect(
      setInstanceFeatureFlags(database, {
        patch: { aiu: false },
        runtime: SAFE_INSTANCE_FEATURE_RUNTIME_PREREQUISITES,
        actorId: "operator:bob",
        reason: "Confirm AIU remains disabled",
      }),
    ).resolves.toMatchObject({ changedFlags: [], workerRestartRequired: true });
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("bounds audit actor metadata", async () => {
    const { database } = databaseWith(settings());
    await expect(
      setInstanceFeatureFlags(database, {
        patch: { aiu: true },
        runtime: {
          ...SAFE_INSTANCE_FEATURE_RUNTIME_PREREQUISITES,
          aiuEnabled: true,
          aiuMode: "observe",
        },
        actorId: "x".repeat(257),
        reason: "Actor value is too long",
      }),
    ).rejects.toThrow(/between 1 and 256/u);
  });

  it("ignores a stale FEATURE_AIU creation default when an operator disables persisted AIU", async () => {
    const environment = loadFeatureFlagOperatorEnvironment({
      DATABASE_URL: "postgresql://operator:test@postgres:5432/control",
      CLICKHOUSE_PASSWORD: "clickhouse-runtime-password",
      FEATURE_AIU: "true",
      AIU_ENABLED: "false",
      AIU_MODE: "disabled",
    });
    const { database } = databaseWith(settings({ featureAiu: true }));

    await expect(
      setInstanceFeatureFlags(database, {
        patch: { aiu: false },
        runtime: featureRuntimePrerequisitesFromEnvironment(environment),
        actorId: "operator:recovery",
        reason: "Disable AIU during rollback",
      }),
    ).resolves.toMatchObject({
      after: { aiu: false },
      changedFlags: ["aiu"],
      workerRestartRequired: true,
    });
  });
});

import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import {
  ReconciliationRunStatus,
  ReconciliationRunType,
  type DatabaseClient,
  type Prisma,
} from "@tokenpilot/db";
import {
  RECONCILIATION_REBUILD_JOB,
  RECONCILIATION_REPLAY_JOB,
  type ReconciliationJobData,
} from "@tokenpilot/shared";

import type { ApiConfiguration } from "../../src/api-config.js";
import type { AuditContextService } from "../../src/audit-context.js";
import type { AuditService } from "../../src/audit.service.js";
import { ReconciliationService } from "../../src/reconciliation/reconciliation.service.js";

const sourceRunId = "5c143894-d041-4b56-8631-fab9d0e6de70";
const sourceDiffId = "32369bd3-c543-47a4-9eb5-cfdca5a3e2f5";
const replayRunId = "aee9735d-3f87-43b3-9d06-1d1bf64ce35f";
const sourceRangeStart = new Date("2026-07-16T00:00:00.000Z");
const sourceRangeEnd = new Date("2026-07-16T01:00:00.000Z");
const earliestEventTime = new Date("2026-07-01T00:00:00.000Z");
const applicationId = "00000000-0000-4000-8000-000000000001";

const configuration: ApiConfiguration = {
  instanceId: "reconciliation-test-01",
  environment: "test",
  timezone: "UTC",
  baseCurrency: "USD",
  webBaseUrl: "http://127.0.0.1:3000",
  databaseUrl: "postgresql://test:test@127.0.0.1:5432/test",
  redisUrl: "redis://127.0.0.1:6379/15",
  clickhouseDatabase: "ai_control_plane_test",
  apiKeyPepper: "reconciliation-api-key-pepper-00000001",
  port: 4000,
  logLevel: "silent",
  maxBatchSize: 500,
  maxCompressedBytes: 1_048_576,
  maxDecompressedBytes: 5_242_880,
  requestTimeoutMs: 10_000,
  rateLimitMax: 1_000,
  loginRateLimitMax: 3,
  loginRateLimitWindowSeconds: 900,
  connectorStaleAfterSeconds: 60,
  connectorBacklogAlertDepth: 5,
};

function sourceRun() {
  return {
    id: sourceRunId,
    applicationId,
    idempotencyKey: null,
    runType: ReconciliationRunType.HOURLY,
    rangeStart: sourceRangeStart,
    rangeEnd: sourceRangeEnd,
    status: ReconciliationRunStatus.COMPLETED,
    pgWatermark: sourceRangeEnd,
    chWatermark: sourceRangeEnd,
    scopeJson: {},
    summaryJson: {},
    startedBy: null,
    startedAt: sourceRangeStart,
    finishedAt: sourceRangeEnd,
    error: null,
  };
}

interface CreateRunInput {
  readonly data: {
    readonly id?: string;
    readonly applicationId: string;
    readonly runType: ReconciliationRunType;
    readonly rangeStart: Date;
    readonly rangeEnd: Date;
    readonly scopeJson: Prisma.InputJsonValue;
  };
}

function harness(diffType: string) {
  const createRun = vi.fn(async ({ data }: CreateRunInput) => ({
    id: data.id ?? replayRunId,
    applicationId: data.applicationId,
    idempotencyKey: null,
    runType: data.runType,
    rangeStart: data.rangeStart,
    rangeEnd: data.rangeEnd,
    status: ReconciliationRunStatus.QUEUED,
    pgWatermark: null,
    chWatermark: null,
    scopeJson: data.scopeJson,
    summaryJson: {},
    startedBy: null,
    startedAt: new Date("2026-07-17T00:00:00.000Z"),
    finishedAt: null,
    error: null,
    _count: { diffs: 0 },
  }));
  const transaction = { reconciliationRun: { create: createRun } };
  const findDiff = vi.fn().mockResolvedValue({
    id: sourceDiffId,
    runId: sourceRunId,
    diffType,
    run: sourceRun(),
  });
  const findEarliestEvent = vi.fn().mockResolvedValue({ eventTime: earliestEventTime });
  const database = {
    reconciliationDiff: { findFirst: findDiff },
    usageEventRegistry: { findFirst: findEarliestEvent },
    $transaction: vi.fn((callback: (client: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
  } as unknown as DatabaseClient;
  const queueAdd = vi.fn().mockResolvedValue({});
  const queue = { add: queueAdd } as unknown as Queue<ReconciliationJobData>;
  const auditRecord = vi.fn().mockResolvedValue(undefined);
  const audit = { record: auditRecord } as unknown as AuditService;
  const auditContext = {
    current: vi.fn().mockReturnValue({
      actorId: "reconciliation-test-actor",
      applicationId,
    }),
  } as unknown as AuditContextService;
  const service = new ReconciliationService(database, queue, audit, auditContext, configuration);

  return {
    service,
    database,
    createRun,
    findEarliestEvent,
    queueAdd,
    auditRecord,
  };
}

describe.each(["USAGE_NORMALIZATION_MISMATCH", "DUPLICATE_PROJECTION"])(
  "fresh ClickHouse rebuild routing for %s",
  (diffType) => {
    it("returns a fresh rebuild plan for dry-run without persisting or queueing work", async () => {
      const fixture = harness(diffType);

      const result = await fixture.service.replayDiff(sourceDiffId, {
        mode: "dry_run",
        reason: "Preview the fresh projection rebuild",
      });

      expect(result).toMatchObject({
        accepted: false,
        dry_run: true,
        plan: {
          rebuildId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
          database: configuration.clickhouseDatabase,
          steps: [
            "clear_isolated_database",
            "create_current_schema",
            "replay_postgresql_outbox",
            "verify_current_projection",
          ],
        },
      });
      expect(fixture.findEarliestEvent).not.toHaveBeenCalled();
      expect(fixture.database.$transaction).not.toHaveBeenCalled();
      expect(fixture.queueAdd).not.toHaveBeenCalled();
      expect(fixture.auditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "reconciliation.rebuild.previewed",
          objectType: "reconciliation_diff",
          objectId: sourceDiffId,
          after: result.plan,
        }),
      );
    });

    it("creates a REBUILD run with the source diff and queues the rebuild job", async () => {
      const fixture = harness(diffType);

      const result = await fixture.service.replayDiff(sourceDiffId, {
        mode: "execute",
        reason: "Rebuild the current ClickHouse projection",
      });
      if (result.run === undefined || !("rebuildId" in result.plan)) {
        throw new TypeError("Expected an executed fresh rebuild");
      }

      expect(result).toMatchObject({
        accepted: true,
        run: { run_type: "rebuild", status: "queued" },
        plan: { database: configuration.clickhouseDatabase },
      });
      expect(result.run.id).toBe(result.plan.rebuildId);
      expect(fixture.createRun).toHaveBeenCalledWith({
        data: {
          id: result.plan.rebuildId,
          applicationId,
          runType: ReconciliationRunType.REBUILD,
          rangeStart: earliestEventTime,
          rangeEnd: expect.any(Date),
          scopeJson: {
            operation: "rebuild",
            plan: result.plan,
            source_diff_id: sourceDiffId,
            reason: "Rebuild the current ClickHouse projection",
          },
        },
        include: { _count: { select: { diffs: true } } },
      });
      expect(fixture.queueAdd).toHaveBeenCalledWith(
        RECONCILIATION_REBUILD_JOB,
        { kind: "rebuild", runId: result.run.id },
        { jobId: `reconciliation-rebuild-${result.run.id}` },
      );
    });
  },
);

describe("ordinary reconciliation replay routing", () => {
  it("keeps PRICE_VERSION_MISMATCH on the provider-cost replay path", async () => {
    const fixture = harness("PRICE_VERSION_MISMATCH");

    const result = await fixture.service.replayDiff(sourceDiffId, {
      mode: "execute",
      reason: "Recalculate provider cost with the current price",
    });

    expect(result).toMatchObject({
      accepted: true,
      run: { id: replayRunId, run_type: "manual", status: "queued" },
      plan: {
        replayType: "rerun_provider_cost",
        dryRun: false,
        providerCostCorrection: "replacement_and_reversal",
      },
    });
    expect(fixture.findEarliestEvent).not.toHaveBeenCalled();
    expect(fixture.createRun).toHaveBeenCalledWith({
      data: {
        applicationId,
        runType: ReconciliationRunType.MANUAL,
        rangeStart: sourceRangeStart,
        rangeEnd: sourceRangeEnd,
        scopeJson: {
          operation: "replay",
          plan: result.plan,
          source_diff_id: sourceDiffId,
          reason: "Recalculate provider cost with the current price",
        },
      },
      include: { _count: { select: { diffs: true } } },
    });
    expect(fixture.queueAdd).toHaveBeenCalledWith(
      RECONCILIATION_REPLAY_JOB,
      { kind: "replay", runId: replayRunId },
      { jobId: `reconciliation-replay-${replayRunId}` },
    );
  });
});

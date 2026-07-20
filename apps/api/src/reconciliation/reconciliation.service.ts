import { createHash, randomUUID } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  ReconciliationDiffStatus,
  ReconciliationRunType,
  type DatabaseClient,
  type ReconciliationRunStatus,
  type ReconciliationSeverity,
} from "@tokenpilot/db";
import {
  planFreshClickHouseRebuild,
  planReconciliationRun,
  planReplay,
} from "@tokenpilot/reconciliation-engine";
import {
  RECONCILIATION_MANUAL_JOB,
  RECONCILIATION_REBUILD_JOB,
  RECONCILIATION_REPLAY_JOB,
  type ReconciliationJobData,
} from "@tokenpilot/shared";

import { AuditContextService } from "../audit-context.js";
import { AuditService } from "../audit.service.js";
import type { ApiConfiguration } from "../api-config.js";
import { withQueueAvailabilityTimeout } from "../background-job-recovery.service.js";
import { API_CONFIGURATION, DATABASE_CLIENT, RECONCILIATION_QUEUE } from "../tokens.js";
import { exportReconciliationRun } from "./reconciliation.export.js";
import {
  defaultRange,
  page,
  parseReconciliationRequest as parsed,
  reconciliationJson as json,
  replayTypeForDiff,
} from "./reconciliation.helpers.js";
import { presentDiff, presentRun } from "./reconciliation.presenter.js";
import {
  createRunSchema,
  diffListSchema,
  listSchema,
  rebuildSchema,
  replaySchema,
  resolveSchema,
} from "./reconciliation.schemas.js";

export { replayTypeForDiff } from "./reconciliation.helpers.js";

@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(RECONCILIATION_QUEUE) private readonly queue: Queue<ReconciliationJobData>,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AuditContextService) private readonly auditContext: AuditContextService,
    @Inject(API_CONFIGURATION) private readonly configuration: ApiConfiguration,
  ) {}

  private applicationId(): string {
    const applicationId = this.auditContext.current().applicationId;
    if (applicationId === undefined) throw new BadRequestException("Application context required");
    return applicationId;
  }

  async createRun(input: unknown) {
    const value = parsed(createRunSchema, input);
    const applicationId = this.applicationId();
    const range = defaultRange(value.type, value.from, value.to);
    let plan;
    try {
      plan = planReconciliationRun({
        applicationId,
        runType: value.type,
        rangeStart: range.from,
        rangeEnd: range.to,
        ...(value.virtual_model === undefined ? {} : { virtualModel: value.virtual_model }),
        ...(value.model_id === undefined ? {} : { modelId: value.model_id }),
        ...(value.user_id === undefined ? {} : { userId: value.user_id }),
      });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Invalid run range");
    }
    const idempotencyKey = `manual:${createHash("sha256").update(JSON.stringify(plan)).digest("hex")}`;
    const run = await this.database.$transaction(async (transaction) => {
      const created = await transaction.reconciliationRun.upsert({
        where: { idempotencyKey },
        create: {
          applicationId,
          idempotencyKey,
          runType: value.type.toUpperCase() as ReconciliationRunType,
          rangeStart: new Date(plan.rangeStart),
          rangeEnd: new Date(plan.rangeEnd),
          scopeJson: json({
            virtual_model: plan.virtualModel,
            model_id: plan.modelId,
            user_id: plan.userId,
            asynchronous: true,
          }),
        },
        update: {},
        include: { _count: { select: { diffs: true } } },
      });
      await this.audit.record(
        {
          action: "reconciliation.run.requested",
          objectType: "reconciliation_run",
          objectId: created.id,
          after: { plan, idempotency_key: idempotencyKey },
          reason: value.reason,
        },
        transaction,
      );
      return created;
    });
    await this.enqueue(RECONCILIATION_MANUAL_JOB, { kind: "run", runId: run.id }, run.id);
    return presentRun(run);
  }

  async listRuns(input: Record<string, unknown>) {
    const applicationId = this.applicationId();
    const value = parsed(listSchema, input);
    const pageNumber = value.page ?? 1;
    const pageSize = value.page_size ?? 25;
    const where =
      value.status === undefined
        ? { applicationId }
        : { applicationId, status: value.status.toUpperCase() as ReconciliationRunStatus };
    const [runs, total] = await Promise.all([
      this.database.reconciliationRun.findMany({
        where,
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        skip: (pageNumber - 1) * pageSize,
        take: pageSize,
        include: { _count: { select: { diffs: true } } },
      }),
      this.database.reconciliationRun.count({ where }),
    ]);
    return page(runs.map(presentRun), pageNumber, pageSize, total, "runs");
  }

  async getRun(id: string) {
    const run = await this.database.reconciliationRun.findFirst({
      where: { id, applicationId: this.applicationId() },
      include: { _count: { select: { diffs: true } } },
    });
    if (run === null) throw new NotFoundException("Reconciliation run not found");
    return presentRun(run);
  }

  async listDiffs(input: Record<string, unknown>, forcedRunId?: string) {
    const value = parsed(diffListSchema, {
      ...input,
      ...(forcedRunId === undefined ? {} : { run_id: forcedRunId }),
    });
    const pageNumber = value.page ?? 1;
    const pageSize = value.page_size ?? 25;
    const where = {
      run: { applicationId: this.applicationId() },
      ...(value.run_id === undefined ? {} : { runId: value.run_id }),
      ...(value.status === undefined
        ? {}
        : { status: value.status.toUpperCase() as ReconciliationDiffStatus }),
      ...(value.severity === undefined
        ? {}
        : { severity: value.severity.toUpperCase() as ReconciliationSeverity }),
    };
    const [diffs, total] = await Promise.all([
      this.database.reconciliationDiff.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (pageNumber - 1) * pageSize,
        take: pageSize,
      }),
      this.database.reconciliationDiff.count({ where }),
    ]);
    return page(diffs.map(presentDiff), pageNumber, pageSize, total, "diffs");
  }

  async replayDiff(id: string, input: unknown) {
    const value = parsed(replaySchema, input);
    const diff = await this.database.reconciliationDiff.findFirst({
      where: { id, run: { applicationId: this.applicationId() } },
      include: { run: true },
    });
    if (diff === null) throw new NotFoundException("Reconciliation diff not found");
    const actor = this.auditContext.current().actorId;
    if (
      diff.diffType === "USAGE_NORMALIZATION_MISMATCH" ||
      diff.diffType === "DUPLICATE_PROJECTION"
    ) {
      const rebuildId = randomUUID();
      const plan = planFreshClickHouseRebuild({
        rebuildId,
        database: this.configuration.clickhouseDatabase,
      });
      if (value.mode === "dry_run") {
        await this.audit.record({
          action: "reconciliation.rebuild.previewed",
          objectType: "reconciliation_diff",
          objectId: diff.id,
          after: plan,
          reason: value.reason,
        });
        return { accepted: false, dry_run: true, plan };
      }
      const now = new Date();
      const earliest = await this.database.usageEventRegistry.findFirst({
        where: { applicationId: this.applicationId() },
        orderBy: { eventTime: "asc" },
        select: { eventTime: true },
      });
      const run = await this.createOperationRun({
        id: rebuildId,
        type: ReconciliationRunType.REBUILD,
        rangeStart: earliest?.eventTime ?? now,
        rangeEnd: now,
        operation: "rebuild",
        plan,
        sourceDiffId: diff.id,
        reason: value.reason,
      });
      await this.enqueue(RECONCILIATION_REBUILD_JOB, { kind: "rebuild", runId: run.id }, run.id);
      return { accepted: true, run: presentRun(run), plan };
    }
    let plan;
    try {
      plan = planReplay({
        replayType: replayTypeForDiff(diff.diffType),
        rangeStart: diff.run.rangeStart.toISOString(),
        rangeEnd: diff.run.rangeEnd.toISOString(),
        dryRun: value.mode === "dry_run",
        reason: value.reason,
        requestedBy: actor,
        existingProviderCostLedgerEffects: true,
        existingAiuLedgerEffects: true,
        wouldCreateAiuLedger: false,
      });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Invalid replay");
    }
    if (value.mode === "dry_run") {
      await this.audit.record({
        action: "reconciliation.replay.previewed",
        objectType: "reconciliation_diff",
        objectId: diff.id,
        after: plan,
        reason: value.reason,
      });
      return { accepted: false, dry_run: true, plan };
    }
    const run = await this.createOperationRun({
      type: ReconciliationRunType.MANUAL,
      rangeStart: diff.run.rangeStart,
      rangeEnd: diff.run.rangeEnd,
      operation: "replay",
      plan,
      sourceDiffId: diff.id,
      reason: value.reason,
    });
    await this.enqueue(RECONCILIATION_REPLAY_JOB, { kind: "replay", runId: run.id }, run.id);
    return { accepted: true, run: presentRun(run), plan };
  }

  async resolveDiff(id: string, input: unknown) {
    const value = parsed(resolveSchema, input);
    const resolvedBy = this.auditContext.current().actorId;
    return this.database.$transaction(async (transaction) => {
      const before = await transaction.reconciliationDiff.findFirst({
        where: { id, run: { applicationId: this.applicationId() } },
      });
      if (before === null) throw new NotFoundException("Reconciliation diff not found");
      if (
        before.status !== ReconciliationDiffStatus.OPEN &&
        before.status !== ReconciliationDiffStatus.INVESTIGATING
      ) {
        throw new ConflictException("Reconciliation diff is already closed");
      }
      const after = await transaction.reconciliationDiff.update({
        where: { id },
        data: {
          status:
            value.resolution === "ignored"
              ? ReconciliationDiffStatus.IGNORED
              : ReconciliationDiffStatus.RESOLVED,
          resolution: `${value.resolution}: ${value.note}`,
          resolvedBy,
          resolvedAt: new Date(),
        },
      });
      await this.audit.record(
        {
          action: "reconciliation.diff.resolved",
          objectType: "reconciliation_diff",
          objectId: id,
          before: presentDiff(before),
          after: presentDiff(after),
          reason: value.note,
        },
        transaction,
      );
      return presentDiff(after);
    });
  }

  async rebuildClickHouse(input: unknown) {
    const value = parsed(rebuildSchema, input);
    const now = new Date();
    const rebuildId = randomUUID();
    const plan = planFreshClickHouseRebuild({
      rebuildId,
      database: this.configuration.clickhouseDatabase,
    });
    const earliest = await this.database.usageEventRegistry.findFirst({
      where: { applicationId: this.applicationId() },
      orderBy: { eventTime: "asc" },
      select: { eventTime: true },
    });
    const run = await this.createOperationRun({
      id: rebuildId,
      type: ReconciliationRunType.REBUILD,
      rangeStart: earliest?.eventTime ?? now,
      rangeEnd: now,
      operation: "rebuild",
      plan,
      reason: value.reason,
    });
    await this.enqueue(RECONCILIATION_REBUILD_JOB, { kind: "rebuild", runId: run.id }, run.id);
    return { accepted: true, run: presentRun(run), plan };
  }

  async exportRun(id: string): Promise<string> {
    return exportReconciliationRun(this.database, this.applicationId(), id);
  }

  private async createOperationRun(input: {
    readonly type: ReconciliationRunType;
    readonly id?: string;
    readonly rangeStart: Date;
    readonly rangeEnd: Date;
    readonly operation: "replay" | "rebuild";
    readonly plan: unknown;
    readonly sourceDiffId?: string;
    readonly reason: string;
  }) {
    return this.database.$transaction(async (transaction) => {
      const run = await transaction.reconciliationRun.create({
        data: {
          applicationId: this.applicationId(),
          ...(input.id === undefined ? {} : { id: input.id }),
          runType: input.type,
          rangeStart: input.rangeStart,
          rangeEnd: input.rangeEnd,
          scopeJson: json({
            operation: input.operation,
            plan: input.plan,
            source_diff_id: input.sourceDiffId ?? null,
            reason: input.reason,
          }),
        },
        include: { _count: { select: { diffs: true } } },
      });
      await this.audit.record(
        {
          action: `reconciliation.${input.operation}.requested`,
          objectType: "reconciliation_run",
          objectId: run.id,
          after: input.plan,
          reason: input.reason,
        },
        transaction,
      );
      return run;
    });
  }

  private async enqueue(name: string, data: ReconciliationJobData, runId: string): Promise<void> {
    try {
      await withQueueAvailabilityTimeout(
        this.queue.add(name, data, { jobId: `reconciliation-${data.kind}-${runId}` }),
      );
    } catch {
      throw new ServiceUnavailableException(
        "Reconciliation request was stored but queueing is temporarily unavailable",
      );
    }
  }
}

import { Prisma, type DatabaseClient } from "@tokenpilot/db";
import type {
  ReconciliationDiff,
  ReconciliationDimensions,
  ReconciliationMetrics,
  ReconciliationRunPlan,
} from "@tokenpilot/reconciliation-engine";

import type {
  ReconciliationRepository,
  ReconciliationRunClaim,
  ReconciliationRunSummary,
  ReconciliationWatermarks,
} from "./types.js";

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function persistedDimensions(value: ReconciliationDimensions) {
  return {
    application_id: value.applicationId,
    granularity: value.bucketSize,
    time_bucket: value.bucketStart,
    virtual_model: value.virtualModel,
    model_id: value.modelId,
    model_tag: value.modelTag,
    provider: value.provider,
    user_id: value.userId,
  } as const;
}

export function restoredDimensions(value: unknown): ReconciliationDimensions {
  const persisted = value as {
    readonly application_id: string;
    readonly granularity: ReconciliationDimensions["bucketSize"];
    readonly time_bucket: string;
    readonly virtual_model: string | null;
    readonly model_id: string | null;
    readonly model_tag: string | null;
    readonly provider: string | null;
    readonly user_id: string | null;
  };
  return {
    applicationId: persisted.application_id,
    bucketSize: persisted.granularity,
    bucketStart: persisted.time_bucket,
    virtualModel: persisted.virtual_model,
    modelId: persisted.model_id,
    modelTag: persisted.model_tag,
    provider: persisted.provider,
    userId: persisted.user_id,
  };
}

export function persistedMetrics(value: Partial<ReconciliationMetrics>) {
  return {
    ...(value.eventCount === undefined ? {} : { event_count: value.eventCount }),
    ...(value.inputTokens === undefined ? {} : { input_tokens: value.inputTokens }),
    ...(value.cachedInputTokens === undefined
      ? {}
      : { cached_input_tokens: value.cachedInputTokens }),
    ...(value.outputTokens === undefined ? {} : { output_tokens: value.outputTokens }),
    ...(value.providerCost === undefined ? {} : { provider_cost: value.providerCost }),
    ...(value.aiuMicros === undefined ? {} : { aiu_micros: value.aiuMicros }),
    ...(value.unpricedCount === undefined ? {} : { unpriced_count: value.unpricedCount }),
    ...(value.unratedCount === undefined ? {} : { unrated_count: value.unratedCount }),
  };
}

export function restoredMetrics(value: unknown): Partial<ReconciliationMetrics> {
  const persisted = value as Readonly<Record<string, unknown>>;
  return {
    ...(typeof persisted.event_count === "string" ? { eventCount: persisted.event_count } : {}),
    ...(typeof persisted.input_tokens === "string" ? { inputTokens: persisted.input_tokens } : {}),
    ...(typeof persisted.cached_input_tokens === "string"
      ? { cachedInputTokens: persisted.cached_input_tokens }
      : {}),
    ...(typeof persisted.output_tokens === "string"
      ? { outputTokens: persisted.output_tokens }
      : {}),
    ...(typeof persisted.provider_cost === "string"
      ? { providerCost: persisted.provider_cost }
      : {}),
    ...(typeof persisted.aiu_micros === "string" ? { aiuMicros: persisted.aiu_micros } : {}),
    ...(typeof persisted.unpriced_count === "string"
      ? { unpricedCount: persisted.unpriced_count }
      : {}),
    ...(typeof persisted.unrated_count === "string"
      ? { unratedCount: persisted.unrated_count }
      : {}),
  };
}

function persistedSummary(summary: ReconciliationRunSummary): Prisma.InputJsonValue {
  const metrics = summary.authoritativeMetrics;
  return json({
    event_count: metrics.eventCount,
    input_tokens: metrics.inputTokens,
    cached_input_tokens: metrics.cachedInputTokens,
    output_tokens: metrics.outputTokens,
    provider_cost: metrics.providerCost,
    aiu_micros: metrics.aiuMicros,
    unpriced_count: metrics.unpricedCount,
    unrated_count: metrics.unratedCount,
    diff_count: String(summary.totalDiffs),
  });
}

function runType(value: ReconciliationRunPlan["runType"]): "HOURLY" | "DAILY" | "MANUAL" {
  return value.toUpperCase() as "HOURLY" | "DAILY" | "MANUAL";
}

function severity(value: ReconciliationDiff["severity"]): string {
  return value.toUpperCase();
}

export interface PersistedDiff {
  readonly diffType: string;
  readonly severity: string;
  readonly dimensionsJson: unknown;
  readonly pgValuesJson: unknown;
  readonly chValuesJson: unknown;
  readonly deltaValuesJson: unknown;
  readonly sampleEventIdsJson: unknown;
  readonly differenceCount: bigint;
  readonly amount: Prisma.Decimal | null;
  readonly explanation: string;
}

export function toPersistedDiff(diff: ReconciliationDiff): PersistedDiff {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(diff.count)) {
    throw new TypeError("reconciliation diff count must be a non-negative integer string");
  }
  return {
    diffType: diff.type,
    severity: severity(diff.severity),
    dimensionsJson:
      diff.dimensions === null ? Prisma.DbNull : json(persistedDimensions(diff.dimensions)),
    pgValuesJson: diff.pgValues === null ? Prisma.DbNull : json(persistedMetrics(diff.pgValues)),
    chValuesJson: diff.chValues === null ? Prisma.DbNull : json(persistedMetrics(diff.chValues)),
    deltaValuesJson: json(persistedMetrics(diff.deltaValues)),
    sampleEventIdsJson: json(diff.sampleEventIds),
    differenceCount: BigInt(diff.count),
    amount: diff.amount === null ? null : new Prisma.Decimal(diff.amount),
    explanation: diff.explanation,
  };
}

function parsePlan(row: {
  readonly applicationId: string;
  readonly runType: string;
  readonly rangeStart: Date;
  readonly rangeEnd: Date;
  readonly pgWatermark: Date | null;
  readonly chWatermark: Date | null;
  readonly scopeJson: unknown;
}): ReconciliationRunPlan {
  const scope = row.scopeJson as {
    readonly virtual_model?: string | null;
    readonly model_id?: string | null;
    readonly user_id?: string | null;
    readonly asynchronous?: boolean;
  };
  return {
    applicationId: row.applicationId,
    runType: row.runType.toLowerCase() as ReconciliationRunPlan["runType"],
    rangeStart: row.rangeStart.toISOString(),
    rangeEnd: row.rangeEnd.toISOString(),
    virtualModel: scope.virtual_model ?? null,
    modelId: scope.model_id ?? null,
    userId: scope.user_id ?? null,
    asynchronous: scope.asynchronous ?? true,
    expectedPgWatermark: row.pgWatermark?.toISOString() ?? null,
    expectedChWatermark: row.chWatermark?.toISOString() ?? null,
  };
}

function parseDiff(row: {
  readonly diffType: string;
  readonly severity: string;
  readonly dimensionsJson: unknown;
  readonly pgValuesJson: unknown;
  readonly chValuesJson: unknown;
  readonly deltaValuesJson: unknown;
  readonly sampleEventIdsJson: unknown;
  readonly differenceCount: bigint;
  readonly amount: Prisma.Decimal | null;
  readonly explanation: string;
}): ReconciliationDiff {
  return {
    type: row.diffType as ReconciliationDiff["type"],
    severity: row.severity.toLowerCase() as ReconciliationDiff["severity"],
    dimensions: row.dimensionsJson === null ? null : restoredDimensions(row.dimensionsJson),
    pgValues:
      row.pgValuesJson === null
        ? null
        : (restoredMetrics(row.pgValuesJson) as ReconciliationMetrics),
    chValues:
      row.chValuesJson === null
        ? null
        : (restoredMetrics(row.chValuesJson) as ReconciliationMetrics),
    deltaValues: restoredMetrics(row.deltaValuesJson),
    sampleEventIds: row.sampleEventIdsJson as readonly string[],
    count: row.differenceCount.toString(),
    amount: row.amount?.toFixed() ?? null,
    explanation: row.explanation,
  };
}

export class PrismaReconciliationRepository implements ReconciliationRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async listApplicationIds(): Promise<readonly string[]> {
    const applications = await this.database.applicationSettings.findMany({
      where: { featureReconciliation: true, application: { status: "ACTIVE" } },
      select: { applicationId: true },
      orderBy: { applicationId: "asc" },
    });
    return applications.map((application) => application.applicationId);
  }

  public async createQueued(
    plan: ReconciliationRunPlan,
    requestedBy: string | null,
    idempotencyKey?: string,
  ): Promise<{ readonly id: string }> {
    const data = {
      applicationId: plan.applicationId,
      runType: runType(plan.runType),
      rangeStart: new Date(plan.rangeStart),
      rangeEnd: new Date(plan.rangeEnd),
      pgWatermark: plan.expectedPgWatermark === null ? null : new Date(plan.expectedPgWatermark),
      chWatermark: plan.expectedChWatermark === null ? null : new Date(plan.expectedChWatermark),
      scopeJson: json({
        virtual_model: plan.virtualModel,
        model_id: plan.modelId,
        user_id: plan.userId,
        asynchronous: plan.asynchronous,
      }),
      ...(requestedBy === null ? {} : { startedBy: requestedBy }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    } as const;
    if (idempotencyKey !== undefined) {
      return this.database.reconciliationRun.upsert({
        where: { idempotencyKey },
        create: data,
        update: {},
        select: { id: true },
      });
    }
    return this.database.reconciliationRun.create({
      data,
      select: { id: true },
    });
  }

  public async claim(runId: string): Promise<ReconciliationRunClaim | null> {
    return this.database.$transaction(async (transaction) => {
      const changed = await transaction.reconciliationRun.updateMany({
        where: { id: runId, status: "QUEUED" },
        data: { status: "RUNNING", startedAt: new Date(), error: null },
      });
      if (changed.count !== 1) return null;
      const row = await transaction.reconciliationRun.findUniqueOrThrow({
        where: { id: runId },
        select: {
          id: true,
          applicationId: true,
          runType: true,
          rangeStart: true,
          rangeEnd: true,
          pgWatermark: true,
          chWatermark: true,
          scopeJson: true,
        },
      });
      return { id: row.id, plan: parsePlan(row) };
    });
  }

  public async replaceDiffs(runId: string, diffs: readonly ReconciliationDiff[]): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const run = await transaction.reconciliationRun.findUnique({
        where: { id: runId },
        select: { status: true },
      });
      if (run?.status !== "RUNNING") {
        throw new Error(`Reconciliation run ${runId} is not running`);
      }
      await transaction.reconciliationDiff.deleteMany({ where: { runId } });
      if (diffs.length === 0) return;
      await transaction.reconciliationDiff.createMany({
        data: diffs.map((diff) => ({ runId, ...toPersistedDiff(diff) })) as never,
      });
    });
  }

  public async complete(
    runId: string,
    watermarks: ReconciliationWatermarks,
    summary: ReconciliationRunSummary,
  ): Promise<void> {
    const changed = await this.database.reconciliationRun.updateMany({
      where: { id: runId, status: "RUNNING" },
      data: {
        status: "COMPLETED",
        pgWatermark: new Date(watermarks.pgEventTime),
        chWatermark: new Date(watermarks.chEventTime),
        summaryJson: persistedSummary(summary),
        finishedAt: new Date(),
        error: null,
      },
    });
    if (changed.count !== 1) throw new Error(`Reconciliation run ${runId} lost its claim`);
  }

  public async fail(runId: string, error: Error): Promise<void> {
    const message = `${error.name}: ${error.message}`.slice(0, 8_000);
    await this.database.reconciliationRun.updateMany({
      where: { id: runId, status: "RUNNING" },
      data: { status: "FAILED", finishedAt: new Date(), error: message },
    });
  }

  public async listDiffs(runId: string): Promise<readonly ReconciliationDiff[]> {
    const rows = await this.database.reconciliationDiff.findMany({
      where: { runId },
      orderBy: [{ severity: "desc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        diffType: true,
        severity: true,
        dimensionsJson: true,
        pgValuesJson: true,
        chValuesJson: true,
        deltaValuesJson: true,
        sampleEventIdsJson: true,
        differenceCount: true,
        amount: true,
        explanation: true,
      },
    });
    return rows.map(parseDiff);
  }
}

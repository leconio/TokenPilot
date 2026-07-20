import { createHash } from "node:crypto";

import type { ClickHouseClient } from "@tokenpilot/clickhouse";
import { Prisma, type DatabaseClient } from "@tokenpilot/db";
import type {
  ReconciliationDimensions,
  ReconciliationMetrics,
  ReconciliationRunPlan,
  ReconciliationSnapshotRow,
} from "@tokenpilot/reconciliation-engine";

import type { ReconciliationSnapshotSource, ReconciliationWatermarks } from "./types.js";
import { clickHouseSnapshotQuery } from "./clickhouse-snapshot-query.js";

interface SnapshotDatabaseRow {
  readonly application_id: string;
  readonly bucket_start: Date;
  readonly virtual_model: string | null;
  readonly model_id: string | null;
  readonly model_tag: string | null;
  readonly provider: string | null;
  readonly user_id: string | null;
  readonly event_count: bigint;
  readonly input_tokens: Prisma.Decimal;
  readonly cached_input_tokens: Prisma.Decimal;
  readonly output_tokens: Prisma.Decimal;
  readonly provider_cost: Prisma.Decimal;
  readonly aiu_micros: bigint;
  readonly unpriced_count: bigint;
  readonly unrated_count: bigint;
  readonly sample_event_ids: string[];
  readonly cost_version_id: string | null;
  readonly aiu_version_id: string | null;
  readonly official_delta_pending: boolean;
  readonly unprojected_adjustment_count: bigint;
}

type ClickHouseSnapshotRow = Readonly<Record<string, string | number | null | string[]>>;

function nullableText(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function clickHouseUtcInstant(value: unknown): string {
  const serialized = String(value);
  const explicitUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/u.test(serialized)
    ? `${serialized.replace(" ", "T")}Z`
    : serialized;
  return new Date(explicitUtc).toISOString();
}

function postgresWhere(plan: ReconciliationRunPlan): Prisma.Sql {
  const conditions = [
    Prisma.sql`registry.application_id = ${plan.applicationId}::uuid`,
    Prisma.sql`registry.event_time >= ${new Date(plan.rangeStart)}`,
    Prisma.sql`registry.event_time < ${new Date(plan.rangeEnd)}`,
  ];
  if (plan.virtualModel !== null) {
    conditions.push(Prisma.sql`registry.virtual_model = ${plan.virtualModel}`);
  }
  if (plan.modelId !== null) {
    conditions.push(Prisma.sql`registry.model_id = ${plan.modelId}::uuid`);
  }
  if (plan.userId !== null) {
    conditions.push(Prisma.sql`registry.external_user_id = ${plan.userId}`);
  }
  return Prisma.sql`${Prisma.join(conditions, " AND ")}`;
}

function clickHouseScope(plan: ReconciliationRunPlan) {
  const conditions = [
    "event.application_id = {application_id:String}",
    "event.event_time >= parseDateTime64BestEffort({range_start:String}, 3, 'UTC')",
    "event.event_time < parseDateTime64BestEffort({range_end:String}, 3, 'UTC')",
  ];
  const queryParams: Record<string, string> = {
    application_id: plan.applicationId,
    range_start: plan.rangeStart,
    range_end: plan.rangeEnd,
  };
  if (plan.virtualModel !== null) {
    conditions.push("event.virtual_model = {virtual_model:String}");
    queryParams.virtual_model = plan.virtualModel;
  }
  if (plan.modelId !== null) {
    conditions.push("event.model_id = {model_id:String}");
    queryParams.model_id = plan.modelId;
  }
  if (plan.userId !== null) {
    conditions.push("event.user_id = {user_id:String}");
    queryParams.user_id = plan.userId;
  }
  return { conditions, queryParams };
}

function identityFingerprint(dimensions: ReconciliationDimensions): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        dimensions.applicationId,
        dimensions.virtualModel,
        dimensions.modelId,
        dimensions.modelTag,
        dimensions.provider,
      ]),
      "utf8",
    )
    .digest("hex")}`;
}

function projectionId(dimensions: ReconciliationDimensions): string {
  return `reconciliation:${createHash("sha256")
    .update(JSON.stringify(dimensions), "utf8")
    .digest("hex")}`;
}

function metrics(input: Record<string, unknown>): ReconciliationMetrics {
  const text = (value: unknown): string =>
    value === null || value === undefined ? "0" : String(value);
  return {
    eventCount: text(input.event_count),
    inputTokens: text(input.input_tokens),
    cachedInputTokens: text(input.cached_input_tokens),
    outputTokens: text(input.output_tokens),
    providerCost: text(input.provider_cost),
    aiuMicros: text(input.aiu_micros),
    unpricedCount: text(input.unpriced_count),
    unratedCount: text(input.unrated_count),
  };
}

function dimensions(row: SnapshotDatabaseRow | ClickHouseSnapshotRow, bucketSize: "hour" | "day") {
  return {
    applicationId: String(row.application_id),
    bucketStart: clickHouseUtcInstant(row.bucket_start),
    bucketSize,
    virtualModel: nullableText(row.virtual_model),
    modelId: nullableText(row.model_id),
    modelTag: nullableText(row.model_tag),
    provider: nullableText(row.provider),
    userId: nullableText(row.user_id),
  } satisfies ReconciliationDimensions;
}

function postgresSnapshot(
  row: SnapshotDatabaseRow,
  bucketSize: "hour" | "day",
): ReconciliationSnapshotRow {
  const identity = dimensions(row, bucketSize);
  return {
    projectionId: projectionId(identity),
    dimensions: identity,
    metrics: metrics(row as unknown as Record<string, unknown>),
    duplicateProjectionCount: "0",
    sampleEventIds: row.sample_event_ids,
    modelIdentityFingerprint: identityFingerprint(identity),
    costVersionId: row.cost_version_id,
    aiuVersionId: row.aiu_version_id,
    payloadHashConflict: false,
    officialDeltaPending: row.official_delta_pending,
    lateEventCount: "0",
    unprojectedAdjustmentCount: row.unprojected_adjustment_count.toString(),
  };
}

function clickHouseSnapshot(
  row: ClickHouseSnapshotRow,
  bucketSize: "hour" | "day",
): ReconciliationSnapshotRow {
  const identity = dimensions(row, bucketSize);
  return {
    projectionId: projectionId(identity),
    dimensions: identity,
    metrics: metrics(row),
    duplicateProjectionCount: String(row.duplicate_projection_count ?? "0"),
    sampleEventIds: Array.isArray(row.sample_event_ids) ? row.sample_event_ids.map(String) : [],
    modelIdentityFingerprint: identityFingerprint(identity),
    costVersionId: nullableText(row.cost_version_id),
    aiuVersionId: nullableText(row.aiu_version_id),
    payloadHashConflict: false,
    officialDeltaPending: false,
    lateEventCount: "0",
    unprojectedAdjustmentCount: "0",
  };
}

export class DualStoreReconciliationSnapshotSource implements ReconciliationSnapshotSource {
  public constructor(
    private readonly database: DatabaseClient,
    private readonly clickhouse: ClickHouseClient,
  ) {}

  public async loadPostgres(
    plan: ReconciliationRunPlan,
  ): Promise<readonly ReconciliationSnapshotRow[]> {
    const bucketSize = plan.runType === "daily" ? "day" : "hour";
    const bucket = Prisma.raw(
      bucketSize === "day"
        ? "date_trunc('day', registry.event_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"
        : "date_trunc('hour', registry.event_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
    );
    const rows = await this.database.$queryRaw<SnapshotDatabaseRow[]>(Prisma.sql`
      SELECT registry.application_id::text AS application_id, ${bucket} AS bucket_start,
        registry.virtual_model, registry.model_id::text AS model_id, registry.model_tag,
        registry.provider, registry.external_user_id AS user_id,
        COUNT(DISTINCT registry.event_id)::bigint AS event_count,
        COALESCE(SUM(rating.input_tokens), 0)::decimal(38,9) AS input_tokens,
        COALESCE(SUM(rating.cached_tokens), 0)::decimal(38,9) AS cached_input_tokens,
        COALESCE(SUM(rating.output_tokens), 0)::decimal(38,9) AS output_tokens,
        COALESCE(SUM(rating.provider_cost), 0)::decimal(38,18) AS provider_cost,
        COALESCE(SUM(rating.aiu_micros), 0)::bigint AS aiu_micros,
        COUNT(*) FILTER (WHERE rating.cost_status = 'unpriced')::bigint AS unpriced_count,
        COUNT(*) FILTER (WHERE rating.aiu_status = 'unrated')::bigint AS unrated_count,
        (array_agg(DISTINCT registry.event_id ORDER BY registry.event_id))[1:100]
          AS sample_event_ids,
        CASE WHEN COUNT(DISTINCT rating.cost_version_id) = 1
          THEN MIN(rating.cost_version_id::text) ELSE NULL END AS cost_version_id,
        CASE WHEN COUNT(DISTINCT rating.aiu_version_id) = 1
          THEN MIN(rating.aiu_version_id::text) ELSE NULL END AS aiu_version_id,
        BOOL_OR(COALESCE(delivery.official_delta_pending, false))
          AS official_delta_pending,
        COALESCE(SUM(delivery.unprojected_adjustment_count), 0)::bigint
          AS unprojected_adjustment_count
      FROM usage_event_registry AS registry
      LEFT JOIN application_usage_ratings AS rating
        ON rating.application_id = registry.application_id AND rating.event_id = registry.event_id
      LEFT JOIN LATERAL (
        SELECT
          BOOL_OR(outbox.status::text IN ('pending', 'failed', 'leased'))
            AS official_delta_pending,
          COUNT(*) FILTER (
            WHERE outbox.status::text IN ('pending', 'failed', 'leased')
          )::bigint AS unprojected_adjustment_count
        FROM pipeline_outbox AS outbox
        WHERE outbox.aggregate_type = 'application_usage_rating'
          AND outbox.aggregate_id = rating.id::text
      ) AS delivery ON TRUE
      WHERE ${postgresWhere(plan)}
      GROUP BY registry.application_id, bucket_start, registry.virtual_model,
        registry.model_id, registry.model_tag, registry.provider, registry.external_user_id
      ORDER BY registry.application_id, bucket_start, registry.virtual_model,
        registry.model_id, registry.model_tag, registry.provider, registry.external_user_id
    `);
    return rows.map((row) => postgresSnapshot(row, bucketSize));
  }

  public async loadClickHouse(
    plan: ReconciliationRunPlan,
  ): Promise<readonly ReconciliationSnapshotRow[]> {
    const bucketSize = plan.runType === "daily" ? "day" : "hour";
    const { conditions, queryParams } = clickHouseScope(plan);
    const result = await this.clickhouse.query({
      query: clickHouseSnapshotQuery(plan, conditions),
      query_params: queryParams,
      format: "JSONEachRow",
    });
    return (await result.json<ClickHouseSnapshotRow>()).map((row) =>
      clickHouseSnapshot(row, bucketSize),
    );
  }

  public async loadWatermarks(plan: ReconciliationRunPlan): Promise<ReconciliationWatermarks> {
    const { conditions, queryParams } = clickHouseScope(plan);
    const [postgres, sync, clickhouseResult] = await Promise.all([
      this.database.usageEventRegistry.aggregate({
        where: {
          applicationId: plan.applicationId,
          eventTime: { gte: new Date(plan.rangeStart), lt: new Date(plan.rangeEnd) },
        },
        _max: { eventTime: true },
      }),
      this.database.clickhouseSyncState.findFirst({
        orderBy: { lastSuccessAt: "desc" },
        select: { lastSuccessAt: true },
      }),
      this.clickhouse.query({
        query: `SELECT toString(max(event_time)) AS watermark
                FROM current_usage_events_raw AS event
                WHERE ${conditions.join(" AND ")}`,
        query_params: queryParams,
        format: "JSONEachRow",
      }),
    ]);
    const clickhouseRows = await clickhouseResult.json<{ readonly watermark: string }>();
    const fallback = new Date(plan.rangeStart).toISOString();
    return {
      pgEventTime: postgres._max.eventTime?.toISOString() ?? fallback,
      chEventTime:
        clickhouseRows[0]?.watermark === undefined || clickhouseRows[0].watermark === ""
          ? fallback
          : clickHouseUtcInstant(clickhouseRows[0].watermark),
      chLastSuccessAt: sync?.lastSuccessAt?.toISOString() ?? fallback,
    };
  }
}

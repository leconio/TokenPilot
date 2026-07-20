import {
  BackgroundJobStatus,
  DeadLetterStatus,
  InboxStatus,
  OutboxStatus,
  type DatabaseClient,
  type PipelineStage,
} from "@tokenpilot/db";
import type { ClickHouseClient } from "@tokenpilot/clickhouse";

export const CURRENT_PIPELINE_FAILURE_STAGES = [
  "received",
  "normalized",
  "model_resolved",
  "provider_cost_rated",
  "aiu_rated",
  "quota_settled",
  "official_committed",
  "outbox_created",
  "completed",
  "dead_letter",
] as const;

export interface CurrentMetricState {
  readonly failures: ReadonlyArray<{
    readonly stage: PipelineStage;
    readonly count: number;
  }>;
  readonly backgroundJobFailures: number;
  readonly unpricedEvents: number;
  readonly currentProviderCost: number;
  readonly previousProviderCost: number;
  readonly durableQueues: ReadonlyArray<{
    readonly queue: "ingestion.inbox" | "pipeline.outbox";
    readonly depth: number;
    readonly failed: number;
  }>;
}

export async function readCurrentMetricState(
  database: DatabaseClient,
  clickhouse: ClickHouseClient,
  currentDayStart: Date,
  previousDayStart: Date,
): Promise<CurrentMetricState> {
  const activeDeadLetterStatuses = [DeadLetterStatus.OPEN, DeadLetterStatus.REPLAY_QUEUED] as const;
  const incompleteInboxStatuses = [
    InboxStatus.PENDING,
    InboxStatus.LEASED,
    InboxStatus.FAILED,
    InboxStatus.DEAD_LETTER,
  ] as const;
  const incompleteOutboxStatuses = [
    OutboxStatus.PENDING,
    OutboxStatus.LEASED,
    OutboxStatus.FAILED,
    OutboxStatus.DEAD_LETTER,
  ] as const;
  const [
    failureGroups,
    backgroundJobFailures,
    analytics,
    inboxDepth,
    inboxFailed,
    outboxDepth,
    outboxFailed,
  ] = await Promise.all([
    database.deadLetterEvent.groupBy({
      by: ["stage"],
      where: { status: { in: [...activeDeadLetterStatuses] } },
      _count: { _all: true },
    }),
    database.backgroundJob.count({ where: { status: BackgroundJobStatus.FAILED } }),
    readAnalyticsMetricState(clickhouse, currentDayStart, previousDayStart),
    database.ingestionInbox.count({ where: { status: { in: [...incompleteInboxStatuses] } } }),
    database.deadLetterEvent.count({
      where: { status: { in: [...activeDeadLetterStatuses] } },
    }),
    database.pipelineOutbox.count({ where: { status: { in: [...incompleteOutboxStatuses] } } }),
    database.pipelineOutbox.count({ where: { status: OutboxStatus.DEAD_LETTER } }),
  ]);
  return {
    failures: failureGroups.map((group) => ({
      stage: group.stage,
      count: group._count._all,
    })),
    backgroundJobFailures,
    unpricedEvents: analytics.unpricedEvents,
    currentProviderCost: analytics.currentProviderCost,
    previousProviderCost: analytics.previousProviderCost,
    durableQueues: [
      { queue: "ingestion.inbox", depth: inboxDepth, failed: inboxFailed },
      { queue: "pipeline.outbox", depth: outboxDepth, failed: outboxFailed },
    ],
  };
}

interface AnalyticsMetricRow {
  readonly unpriced_events: string | number;
  readonly current_provider_cost: string | number;
  readonly previous_provider_cost: string | number;
}

async function readAnalyticsMetricState(
  clickhouse: ClickHouseClient,
  currentDayStart: Date,
  previousDayStart: Date,
) {
  const result = await clickhouse.query({
    query: `
      SELECT
        (
          SELECT count()
          FROM current_usage_events_raw AS event
          WHERE event.event_id NOT IN
          (
            SELECT source_event_id
            FROM current_rating_events
            WHERE rating_kind = 'provider_cost'
            GROUP BY source_event_id
            HAVING argMax(status, tuple(authority_outbox_id, rating_event_id))
              IN ('provisional', 'official')
          )
        ) AS unpriced_events,
        toString(sumIf(
          toInt64(rating_sign) * ifNull(amount_decimal, toDecimal128(0, 18)),
          event_time >= parseDateTime64BestEffort({current_day_start:String}, 3, 'UTC')
        )) AS current_provider_cost,
        toString(sumIf(
          toInt64(rating_sign) * ifNull(amount_decimal, toDecimal128(0, 18)),
          event_time >= parseDateTime64BestEffort({previous_day_start:String}, 3, 'UTC')
            AND event_time < parseDateTime64BestEffort({current_day_start:String}, 3, 'UTC')
        )) AS previous_provider_cost
      FROM current_rating_events
      WHERE rating_kind = 'provider_cost'
        AND isNotNull(amount_decimal)
    `,
    query_params: {
      current_day_start: currentDayStart.toISOString(),
      previous_day_start: previousDayStart.toISOString(),
    },
    format: "JSONEachRow",
  });
  const rows = await result.json<AnalyticsMetricRow>();
  const row = rows[0];
  if (row === undefined) throw new Error("ClickHouse did not return current metric state");
  return {
    unpricedEvents: nonNegativeInteger(row.unpriced_events, "unpriced event count"),
    currentProviderCost: finiteNumber(row.current_provider_cost, "current Provider Cost"),
    previousProviderCost: finiteNumber(row.previous_provider_cost, "previous Provider Cost"),
  };
}

function finiteNumber(value: string | number, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`ClickHouse returned an invalid ${label}`);
  return parsed;
}

function nonNegativeInteger(value: string | number, label: string): number {
  const parsed = finiteNumber(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`ClickHouse returned an invalid ${label}`);
  }
  return parsed;
}

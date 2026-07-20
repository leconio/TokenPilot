import type { ReportQuery } from "./query.js";

const denormalizedFilterFields = new Set([
  "model_tag",
  "virtual_model",
  "provider",
  "route_reason",
]);

const aggregateEventProjection = `
  SELECT
    bucket_start AS event_time,
    application_id,
    virtual_model,
    model_id,
    model_tag,
    provider,
    status,
    route_reason,
    currency,
    provisional_provider_cost,
    official_provider_cost_delta,
    provisional_aiu_micros,
    official_aiu_micros_delta
  FROM current_usage_agg_1m
`;

function filteredEventIds(where: string): string {
  return `
    SELECT event.event_id
    FROM current_usage_events_raw AS event
    WHERE ${where}
  `;
}

function ratingRange(alias: string): string {
  return `
    ${alias}.event_time >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
      AND ${alias}.event_time < parseDateTime64BestEffort({to:String}, 3, 'UTC')
      AND ${alias}.application_id = {application_id:String}
  `;
}

function directRatingEvidence(where: string): string {
  return `
    WITH rating_status AS (
      SELECT
        event.source_event_id,
        argMaxIf(
          event.status,
          tuple(event.authority_outbox_id, event.rating_event_id),
          event.rating_kind = 'provider_cost'
        ) AS provider_cost_status,
        argMaxIf(
          event.status,
          tuple(event.authority_outbox_id, event.rating_event_id),
          event.rating_kind = 'aiu'
        ) AS aiu_status
      FROM current_rating_events AS event
      WHERE ${where}
      GROUP BY event.source_event_id
    )
    SELECT
      countIf(provider_cost_status IN ('provisional', 'official')) AS priced_events,
      countIf(aiu_status IN ('provisional', 'official', 'not_chargeable', 'disabled'))
        AS aiu_rated_count
    FROM rating_status
  `;
}

function scopedRatingEvidence(where: string): string {
  return `
    WITH
      filtered_events AS (${filteredEventIds(where)}),
      rating_status AS (
        SELECT
          rating.source_event_id,
          argMaxIf(
            rating.status,
            tuple(rating.authority_outbox_id, rating.rating_event_id),
            rating.rating_kind = 'provider_cost'
          ) AS provider_cost_status,
          argMaxIf(
            rating.status,
            tuple(rating.authority_outbox_id, rating.rating_event_id),
            rating.rating_kind = 'aiu'
          ) AS aiu_status
        FROM current_rating_events AS rating
        WHERE ${ratingRange("rating")}
          AND rating.source_event_id IN (SELECT event_id FROM filtered_events)
        GROUP BY rating.source_event_id
      )
    SELECT
      countIf(provider_cost_status IN ('provisional', 'official')) AS priced_events,
      countIf(aiu_status IN ('provisional', 'official', 'not_chargeable', 'disabled'))
        AS aiu_rated_count
    FROM rating_status
  `;
}

export function analyticsOverviewQueryPlan(query: ReportQuery) {
  const canFilterRatingsDirectly = query.filters.every(
    (filter) => filter.kind === "builtin" && denormalizedFilterFields.has(filter.field),
  );
  return {
    aggregateEventProjection,
    canFilterRatingsDirectly,
    directRatingEvidence,
    filteredEventIds,
    ratingRange,
    scopedRatingEvidence,
    useMinuteAggregate:
      canFilterRatingsDirectly &&
      query.from.getTime() % 60_000 === 0 &&
      query.to.getTime() % 60_000 === 0,
  } as const;
}

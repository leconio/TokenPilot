import type {
  ClickHouseOutboxRecord,
  ClickHouseSinkIdentity,
  ClickHouseSinkRow,
  MappedClickHouseOutbox,
} from "./types.js";
import {
  array,
  boolean,
  dateTime,
  delivery,
  eventDate,
  object,
  numeric,
  optionalString,
  sha256Fingerprint,
  string,
  type JsonObject,
} from "./payload-readers.js";

function ratingBase(
  record: ClickHouseOutboxRecord,
  identity: ClickHouseSinkIdentity,
  payload: JsonObject,
): ClickHouseSinkRow {
  return {
    application_id: string(payload.application_id, "rating.application_id"),
    instance_id:
      optionalString(payload.instance_id, "rating.instance_id") ??
      identity.instanceId ??
      "control-plane",
    environment: identity.environment,
    event_time: dateTime(payload.event_time, "rating.event_time"),
    source_event_id: string(payload.event_id, "rating.event_id"),
    request_id: optionalString(payload.request_id, "rating.request_id") ?? "",
    attempt_id: optionalString(payload.attempt_id, "rating.attempt_id") ?? "",
    attempt_index: numeric(payload.attempt_index, "rating.attempt_index") ?? 0,
    is_final_attempt: Number(boolean(payload.is_final_attempt, true)),
    operation_id: optionalString(payload.operation_id, "rating.operation_id") ?? "",
    user_id: optionalString(payload.user_id, "rating.user_id") ?? "",
    virtual_model: optionalString(payload.virtual_model, "rating.virtual_model") ?? "",
    model_id: optionalString(payload.model_id, "rating.model_id") ?? "",
    connection_id: optionalString(payload.connection_id, "rating.connection_id") ?? "",
    connection_driver: optionalString(payload.connection_driver, "rating.connection_driver") ?? "",
    request_model: optionalString(payload.request_model, "rating.request_model") ?? "",
    provider: optionalString(payload.provider, "rating.provider") ?? "",
    status: string(payload.status, "rating.status"),
    attempt_outcome: string(payload.attempt_outcome, "rating.attempt_outcome"),
    route_reason: optionalString(payload.route_reason, "rating.route_reason") ?? "",
    authority_outbox_id: (record.replayOfOutboxId ?? record.id).toString(),
    source_outbox_id: record.id.toString(),
  };
}

function positiveMagnitude(value: unknown, name: string): string {
  const text = string(value, name);
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(text)) {
    throw new TypeError(`${name} must be a decimal string`);
  }
  return text.startsWith("-") ? text.slice(1) : text;
}

function nullablePositiveMagnitude(value: unknown, name: string): string | null {
  return value === null ? null : positiveMagnitude(value, name);
}

const terminalStages = new Set([
  "unpriced",
  "invalid_usage",
  "unrated",
  "disabled",
  "not_chargeable",
]);

export function mapProviderRating(
  record: ClickHouseOutboxRecord,
  identity: ClickHouseSinkIdentity,
  payload: JsonObject,
  eventType:
    | "provider_cost.provisional"
    | "provider_cost.official_delta"
    | "provider_cost.adjustment"
    | "provider_cost.unpriced",
): MappedClickHouseOutbox {
  const base = ratingBase(record, identity, payload);
  const deltas = array(payload.deltas, "Provider Cost deltas");
  return {
    outboxId: record.id,
    eventType,
    eventTime: eventDate(payload.event_time, "provider rating event_time"),
    rows: {
      rating_events: deltas.map((value, index) => {
        const delta = object(value, `Provider Cost delta ${index}`);
        const sign = delta.rating_sign;
        if (sign !== 1 && sign !== -1) {
          throw new TypeError(`Provider Cost delta ${index} has invalid sign`);
        }
        const stage = string(delta.rating_stage, `Provider Cost delta ${index}.rating_stage`);
        const allowed =
          eventType === "provider_cost.provisional"
            ? stage === "provisional"
            : eventType === "provider_cost.adjustment"
              ? stage === "correction"
              : eventType === "provider_cost.unpriced"
                ? stage === "reversal" || stage === "unpriced" || stage === "invalid_usage"
                : stage === "official" ||
                  stage === "correction" ||
                  stage === "reversal" ||
                  stage === "unpriced" ||
                  stage === "invalid_usage";
        if (!allowed) throw new TypeError(`${eventType} cannot project rating stage ${stage}`);
        const amount = nullablePositiveMagnitude(
          delta.amount,
          `Provider Cost delta ${index}.amount`,
        );
        if (amount === null && !terminalStages.has(stage)) {
          throw new TypeError(`${eventType} cannot project a null amount for stage ${stage}`);
        }
        const currency = optionalString(delta.currency, `Provider Cost delta ${index}.currency`);
        if (amount !== null && currency === null) {
          throw new TypeError(`${eventType} requires currency for a priced delta`);
        }
        return {
          ...base,
          rating_event_id: string(
            delta.rating_event_id,
            `Provider Cost delta ${index}.rating_event_id`,
          ),
          rating_kind: "provider_cost",
          rating_stage: stage,
          rating_sign: sign,
          usage_type: null,
          currency,
          amount_decimal: amount,
          aiu_micros: null,
          price_version_id: optionalString(
            delta.price_version_id,
            `Provider Cost delta ${index}.price_version_id`,
          ),
          aiu_rate_version_id: null,
          calculation_version: string(
            delta.calculation_version,
            `Provider Cost delta ${index}.calculation_version`,
          ),
          rating_fingerprint: sha256Fingerprint(
            delta.rating_fingerprint,
            `Provider Cost delta ${index}.rating_fingerprint`,
          ),
          reason: string(delta.reason, `Provider Cost delta ${index}.reason`),
          sink_delivery_id: delivery(record, `provider-rating:${index}`),
        };
      }),
    },
  };
}

export function mapAiuRating(
  record: ClickHouseOutboxRecord,
  identity: ClickHouseSinkIdentity,
  payload: JsonObject,
  eventType: "aiu.provisional" | "aiu.official_delta" | "aiu.decision",
): MappedClickHouseOutbox {
  const base = ratingBase(record, identity, payload);
  const deltas = array(payload.deltas, "AIU rating deltas");
  const rows: ClickHouseSinkRow[] = [];
  for (const [deltaIndex, value] of deltas.entries()) {
    const delta = object(value, `AIU delta ${deltaIndex}`);
    const sign = delta.rating_sign;
    if (sign !== 1 && sign !== -1) throw new TypeError(`AIU delta ${deltaIndex} has invalid sign`);
    const stage = string(delta.rating_stage, `AIU delta ${deltaIndex}.rating_stage`);
    const allowed =
      eventType === "aiu.provisional"
        ? stage === "provisional"
        : eventType === "aiu.decision"
          ? stage === "reversal" || terminalStages.has(stage)
          : stage === "official" ||
            stage === "correction" ||
            stage === "reversal" ||
            terminalStages.has(stage);
    if (!allowed) throw new TypeError(`${eventType} cannot project rating stage ${stage}`);
    const lines = array(delta.lines, `AIU delta ${deltaIndex}.lines`);
    const magnitudes =
      lines.length === 0
        ? [{ usage_type: null, aiu_micros: delta.total_aiu_micros }]
        : lines.map((line) => object(line, `AIU delta ${deltaIndex} line`));
    for (const [lineIndex, line] of magnitudes.entries()) {
      const aiuMicros = nullablePositiveMagnitude(line.aiu_micros, "AIU aiu_micros");
      if (aiuMicros === null && !terminalStages.has(stage)) {
        throw new TypeError(`${eventType} cannot project null AIU for stage ${stage}`);
      }
      rows.push({
        ...base,
        rating_event_id: `${string(delta.rating_event_id, "AIU rating_event_id")}:${lineIndex}`,
        rating_kind: "aiu",
        rating_stage: stage,
        rating_sign: sign,
        usage_type: optionalString(line.usage_type, "AIU usage_type"),
        currency: null,
        amount_decimal: null,
        aiu_micros: aiuMicros,
        price_version_id: null,
        aiu_rate_version_id: optionalString(delta.aiu_rate_version_id, "AIU rate version"),
        calculation_version: string(delta.calculation_version, "AIU calculation version"),
        rating_fingerprint: sha256Fingerprint(delta.rating_fingerprint, "AIU rating fingerprint"),
        reason: string(delta.reason, "AIU delta reason"),
        sink_delivery_id: delivery(record, `aiu-rating:${deltaIndex}:${lineIndex}`),
      });
    }
  }
  return {
    outboxId: record.id,
    eventType,
    eventTime: eventDate(payload.event_time, "AIU rating event_time"),
    rows: { rating_events: rows },
  };
}

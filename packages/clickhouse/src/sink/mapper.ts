import {
  CLICKHOUSE_PIPELINE_EVENT_TYPES,
  type ClickHouseOutboxRecord,
  type ClickHousePipelineEventType,
  type ClickHouseSinkIdentity,
  type ClickHouseSinkRow,
  type MappedClickHouseOutbox,
} from "./types.js";
import {
  array,
  boolean,
  dateTime,
  delivery,
  dimensionMap,
  eventDate,
  object,
  optionalString,
  redactClickHouseRawPayload,
  string,
  numeric,
  type JsonObject,
} from "./payload-readers.js";
import { mapAiuRating, mapProviderRating } from "./rating-mapper.js";
import { typedPropertyColumns } from "./property-mapper.js";

export { redactClickHouseRawPayload } from "./payload-readers.js";

function eventType(value: string): ClickHousePipelineEventType {
  if ((CLICKHOUSE_PIPELINE_EVENT_TYPES as readonly string[]).includes(value)) {
    return value as ClickHousePipelineEventType;
  }
  throw new TypeError(`Unsupported ClickHouse outbox event type: ${value}`);
}

function usageBase(
  record: ClickHouseOutboxRecord,
  identity: ClickHouseSinkIdentity,
  payload: JsonObject,
): { readonly normalized: JsonObject; readonly base: ClickHouseSinkRow; readonly at: Date } {
  const normalized = object(payload.normalized, "normalized usage");
  const source = object(normalized.source, "normalized source");
  const request = object(normalized.request, "normalized request");
  const user = object(normalized.user, "normalized user");
  const model = object(normalized.model, "normalized model");
  const result = object(normalized.result, "normalized result");
  const route = normalized.route === null ? null : object(normalized.route, "normalized route");
  const resolution = object(payload.resolution ?? {}, "model resolution");
  const eventTime = string(normalized.event_time, "normalized.event_time");
  return {
    normalized,
    at: eventDate(eventTime, "normalized.event_time"),
    base: {
      application_id: string(payload.application_id, "application_id"),
      instance_id: string(source.instance_id, "normalized.source.instance_id"),
      environment: identity.environment,
      event_time: dateTime(eventTime, "normalized.event_time"),
      event_id: string(normalized.event_id, "normalized.event_id"),
      request_id: string(request.request_id, "normalized.request.request_id"),
      attempt_id: string(request.attempt_id, "normalized.request.attempt_id"),
      attempt_index: numeric(request.attempt_index, "normalized.request.attempt_index") ?? 0,
      is_final_attempt: Number(boolean(request.is_final_attempt)),
      operation_id: optionalString(request.operation_id, "normalized.request.operation_id") ?? "",
      session_id: optionalString(request.session_id, "normalized.request.session_id") ?? "",
      conversation_id:
        optionalString(request.conversation_id, "normalized.request.conversation_id") ?? "",
      trace_id: optionalString(request.trace_id, "normalized.request.trace_id") ?? "",
      user_id: string(user.user_id, "normalized.user.user_id"),
      display_user: optionalString(user.display_user, "normalized.user.display_user") ?? "",
      user_tags: stringArray(payload.user_tags ?? [], "user_tags"),
      application_version:
        optionalString(normalized.application_version, "normalized.application_version") ?? "",
      sdk_version: optionalString(normalized.sdk_version, "normalized.sdk_version") ?? "",
      connector_version:
        optionalString(normalized.connector_version, "normalized.connector_version") ?? "",
      config_version: optionalString(normalized.config_version, "normalized.config_version") ?? "",
      virtual_model: optionalString(model.virtual_model, "normalized.model.virtual_model") ?? "",
      model_id:
        optionalString(resolution.modelId, "resolution.modelId") ??
        optionalString(model.model_id, "normalized.model.model_id") ??
        "",
      connection_id: optionalString(model.connection_id, "normalized.model.connection_id") ?? "",
      connection_driver:
        optionalString(model.connection_driver, "normalized.model.connection_driver") ?? "",
      request_model: string(model.request_model, "normalized.model.request_model"),
      provider: optionalString(model.provider, "normalized.model.provider") ?? "",
      status: string(result.status, "normalized.result.status"),
      route_reason: route === null ? "" : (optionalString(route.reason, "route.reason") ?? ""),
      analytics_dimensions: dimensionMap(normalized.analytics_dimensions),
      ...typedPropertyColumns(payload, normalized),
      source_outbox_id: record.id.toString(),
    },
  };
}

function mapRaw(
  record: ClickHouseOutboxRecord,
  identity: ClickHouseSinkIdentity,
  payload: JsonObject,
): MappedClickHouseOutbox {
  const { normalized, base, at } = usageBase(record, identity, payload);
  const result = object(normalized.result, "normalized result");
  const route = normalized.route === null ? null : object(normalized.route, "normalized route");
  const event = object(payload.event, "raw usage event");
  return {
    outboxId: record.id,
    eventType: "usage_events_raw",
    eventTime: at,
    rows: {
      usage_events_raw: [
        {
          ...base,
          received_at: record.createdAt.toISOString().replace("T", " ").replace("Z", ""),
          schema_version: string(normalized.schema_version, "normalized.schema_version"),
          error_class: optionalString(result.error_class, "result.error_class") ?? "",
          http_status: numeric(result.http_status, "result.http_status"),
          latency_ms: numeric(result.latency_ms, "result.latency_ms"),
          fallback_from:
            route === null
              ? ""
              : (optionalString(route.fallback_from, "route.fallback_from") ?? ""),
          is_final_success_attempt:
            route === null ? 0 : Number(boolean(route.is_final_success_attempt)),
          is_user_visible_operation:
            route === null ? 1 : Number(boolean(route.is_user_visible_operation, true)),
          raw_payload: JSON.stringify(redactClickHouseRawPayload(event)),
          payload_hash: string(payload.payload_hash, "payload_hash"),
          sink_delivery_id: delivery(record, "raw"),
        },
      ],
    },
  };
}

function mapUsageLines(
  record: ClickHouseOutboxRecord,
  identity: ClickHouseSinkIdentity,
  payload: JsonObject,
): MappedClickHouseOutbox {
  const { normalized, base, at } = usageBase(record, identity, payload);
  const lines = array(normalized.usage_lines, "normalized.usage_lines");
  return {
    outboxId: record.id,
    eventType: "usage_lines",
    eventTime: at,
    rows: {
      usage_lines: lines.map((value, index) => {
        const line = object(value, `usage line ${index}`);
        const usageType = string(line.usage_type, `usage line ${index}.usage_type`);
        const unitKey = optionalString(line.unit_key, `usage line ${index}.unit_key`) ?? "";
        return {
          ...base,
          usage_line_id: `${String(base.event_id)}:${usageType}:${unitKey || "-"}`,
          usage_type: usageType,
          quantity: string(line.quantity, `usage line ${index}.quantity`),
          unit: string(line.unit, `usage line ${index}.unit`),
          unit_key: unitKey,
          is_estimated: Number(boolean(line.is_estimated)),
          confidence: string(line.confidence, `usage line ${index}.confidence`),
          source_path: string(line.source_path, `usage line ${index}.source_path`),
          sink_delivery_id: delivery(record, `usage:${index}`),
        };
      }),
    },
  };
}

function stringArray(value: unknown, name: string): readonly string[] {
  const values = array(value, name);
  if (!values.every((item) => typeof item === "string")) {
    throw new TypeError(`${name} must contain only strings`);
  }
  return [...new Set(values as readonly string[])].sort();
}

function mapApplicationUserProfile(
  record: ClickHouseOutboxRecord,
  payload: JsonObject,
): MappedClickHouseOutbox {
  const profileVersion = record.replayOfOutboxId ?? record.id;
  const sinkDeliveryId = delivery(record, "user-profile");
  const updatedAt = string(payload.profile_updated_at, "profile.profile_updated_at");
  const status = string(payload.status, "profile.status");
  if (status !== "active" && status !== "blocked") {
    throw new TypeError("profile.status must be active or blocked");
  }
  const propertyColumns = typedPropertyColumns(payload, {
    user_properties: payload.properties ?? {},
  });
  return {
    outboxId: record.id,
    eventType: "application_user.profile",
    eventTime: eventDate(updatedAt, "profile.profile_updated_at"),
    rows: {
      application_user_profiles: [
        {
          application_id: string(payload.application_id, "profile.application_id"),
          user_id: string(payload.user_id, "profile.user_id"),
          user_record_id: string(payload.user_record_id, "profile.user_record_id"),
          display_user: optionalString(payload.display_user, "profile.display_user") ?? "",
          tags: stringArray(payload.tags, "profile.tags"),
          status,
          first_seen_at: dateTime(payload.first_seen_at, "profile.first_seen_at"),
          last_seen_at: dateTime(payload.last_seen_at, "profile.last_seen_at"),
          profile_updated_at: dateTime(updatedAt, "profile.profile_updated_at"),
          user_text_properties: propertyColumns.user_text_properties ?? {},
          user_number_properties: propertyColumns.user_number_properties ?? {},
          user_boolean_properties: propertyColumns.user_boolean_properties ?? {},
          user_datetime_properties: propertyColumns.user_datetime_properties ?? {},
          user_enum_properties: propertyColumns.user_enum_properties ?? {},
          user_text_list_properties: propertyColumns.user_text_list_properties ?? {},
          properties_json: JSON.stringify(redactClickHouseRawPayload(payload.properties ?? {})),
          profile_version: profileVersion.toString(),
          sink_delivery_id: sinkDeliveryId,
          source_outbox_id: record.id.toString(),
        },
      ],
    },
  };
}

/** Converts one durable PG outbox record into stable, replay-identifiable ClickHouse rows. */
export function mapClickHouseOutbox(
  record: ClickHouseOutboxRecord,
  identity: ClickHouseSinkIdentity,
): MappedClickHouseOutbox {
  const type = eventType(record.eventType);
  const payload = object(record.payload, "outbox payload");
  if (type === "usage_events_raw") return mapRaw(record, identity, payload);
  if (type === "usage_lines") return mapUsageLines(record, identity, payload);
  if (type === "application_user.profile") return mapApplicationUserProfile(record, payload);
  if (
    type === "provider_cost.provisional" ||
    type === "provider_cost.official_delta" ||
    type === "provider_cost.adjustment" ||
    type === "provider_cost.unpriced"
  ) {
    return mapProviderRating(record, identity, payload, type);
  }
  if (type === "aiu.provisional" || type === "aiu.official_delta" || type === "aiu.decision") {
    return mapAiuRating(record, identity, payload, type);
  }
  throw new TypeError(`Unmapped ClickHouse outbox event type: ${type}`);
}

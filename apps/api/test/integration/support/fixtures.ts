import { ulid } from "ulid";

import {
  connectorHeartbeatSchema,
  usageEventSchema,
  type ConnectorHeartbeat,
  type UsageEvent,
} from "@tokenpilot/contracts";

export const usageFixture = usageEventSchema.parse({
  schema_version: "2.0",
  event_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  event_time: "2026-07-15T08:00:00.000Z",
  user: { user_id: "integration-user", display_user: "Integration user" },
  source: {
    type: "gateway",
    name: "litellm",
    version: "1.0.0",
    instance_id: "litellm-test-01",
  },
  request: {
    request_id: "request-fixture",
    attempt_id: "attempt-fixture",
    operation_id: null,
    parent_request_id: null,
    session_id: null,
    conversation_id: null,
    trace_id: null,
  },
  model: {
    virtual_model: "text.fast",
    model_tag: "openai/model-test",
    provider: "openai",
  },
  route: null,
  usage: {
    uncached_input_tokens: "10",
    output_tokens: "5",
  },
  analytics_dimensions: {},
  result: { status: "success", http_status: 200, latency_ms: 42, error_class: null },
  source_cost: null,
  privacy: { contains_prompt: false, contains_response: false },
});

export function usageEvent(eventId = ulid()): UsageEvent {
  return {
    ...structuredClone(usageFixture),
    event_id: eventId,
    event_time: new Date().toISOString(),
    request: {
      ...usageFixture.request,
      request_id: `request-${eventId}`,
      attempt_id: `attempt-${eventId}`,
    },
  };
}

export function usageBatch(events: readonly unknown[], batchId = ulid()) {
  return {
    schema_version: "2.0" as const,
    batch_id: batchId,
    sent_at: new Date().toISOString(),
    events: [...events],
  };
}

export function heartbeat(instanceId = "litellm-heartbeat-01"): ConnectorHeartbeat {
  return connectorHeartbeatSchema.parse({
    schema_version: "2.0",
    heartbeat_id: ulid(),
    sent_at: new Date().toISOString(),
    connector: {
      instance_id: instanceId,
      name: "litellm",
      type: "litellm",
      version: "1.2.3",
    },
    capabilities: {
      usage_schema: "2.0",
      application_users: true,
      privacy_mode: "content_free",
      durable_batch_upload: true,
    },
    status: "healthy",
    buffer_depth: 7,
    oldest_event_age_seconds: 12.5,
    last_successful_upload_at: new Date().toISOString(),
  });
}

export function webCookies(header: string | string[] | undefined): {
  cookie: string;
  csrf: string;
  sessionToken: string;
} {
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const pairs = values.flatMap((value) =>
    value
      .split(/,(?=\s*cp_(?:session|csrf)=)/u)
      .map((part) => part.trim().split(";", 1)[0])
      .filter((part): part is string => part !== undefined),
  );
  const parsed = Object.fromEntries(
    pairs.map((pair) => {
      const separator = pair.indexOf("=");
      return [pair.slice(0, separator), decodeURIComponent(pair.slice(separator + 1))];
    }),
  );
  if (parsed.cp_session === undefined || parsed.cp_csrf === undefined) {
    throw new Error("Web session cookies were not issued");
  }
  return {
    cookie: pairs.join("; "),
    csrf: parsed.cp_csrf,
    sessionToken: parsed.cp_session,
  };
}

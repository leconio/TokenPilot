import { usageEventSchema, type RuntimeSnapshot, type UsageEvent } from "@tokenpilot/contracts";

import { AiControlSdkError } from "../errors.js";
import type { RuntimeRouteSelection } from "./routing.js";
import type { RecordUsageInput, ResolvedAiRuntimeContext } from "./types.js";

function allowedDimensions(
  values: Readonly<Record<string, string | number | boolean>>,
  allowed: readonly string[],
): Readonly<Record<string, string | number | boolean>> {
  const allowedKeys = new Set(allowed);
  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!allowedKeys.has(key)) {
      throw new AiControlSdkError(
        "SDK_DIMENSION_NOT_ALLOWED",
        `Analytics dimension ${key} is not allowed by the Runtime Snapshot.`,
      );
    }
    output[key] = value;
  }
  return Object.freeze(output);
}

export { allowedDimensions };

export function buildManualUsageEvent(input: {
  readonly value: RecordUsageInput;
  readonly context: ResolvedAiRuntimeContext;
  readonly snapshot: RuntimeSnapshot;
  readonly route: RuntimeRouteSelection;
  readonly now: Date;
  readonly sdkVersion: string;
  readonly instanceId: string;
}): UsageEvent {
  const { value, context, snapshot, route } = input;
  const candidates = [route.primary, ...route.fallbacks];
  const target =
    value.modelId === undefined
      ? route.primary
      : candidates.find((candidate) => candidate.model_id === value.modelId);
  if (target === undefined) {
    throw new AiControlSdkError(
      "SDK_MANUAL_USAGE_MODEL_INVALID",
      "The reported real model is not a candidate of the selected virtual model.",
    );
  }
  const connection = snapshot.connections[target.connection_id];
  if (connection === undefined) {
    throw new AiControlSdkError(
      "SDK_MANUAL_USAGE_CONNECTION_INVALID",
      "The reported real model references an unknown connection.",
    );
  }
  const status = value.status ?? "success";
  return usageEventSchema.parse({
    schema_version: "2.0",
    event_id: value.eventId,
    event_time: input.now.toISOString(),
    ...(context.applicationVersion === null
      ? {}
      : { application_version: context.applicationVersion }),
    sdk_version: input.sdkVersion,
    config_version: String(route.configurationVersion),
    user: { user_id: context.userId, display_user: context.displayUser },
    ...(Object.keys(context.eventProperties).length === 0
      ? {}
      : { event_properties: structuredClone(context.eventProperties) }),
    ...(Object.keys(context.userProperties).length === 0
      ? {}
      : { user_properties: structuredClone(context.userProperties) }),
    source: {
      type: "sdk",
      name: "tokenpilot-node",
      version: input.sdkVersion,
      instance_id: input.instanceId,
    },
    request: {
      request_id: context.requestId,
      attempt_id: value.attemptId,
      attempt_index: value.attemptIndex ?? 0,
      is_final_attempt: value.isFinalAttempt ?? true,
      operation_id: context.operationId,
      parent_request_id: context.parentRequestId,
      session_id: context.sessionId,
      conversation_id: context.conversationId,
      trace_id: context.traceId,
      reservation_id: null,
    },
    model: {
      virtual_model: route.virtualModel,
      model_id: target.model_id,
      connection_id: target.connection_id,
      connection_driver: connection.driver,
      request_model: target.request_model,
      provider: target.provider,
    },
    route: {
      configuration_version: String(route.configurationVersion),
      rule: route.ruleId,
      reason: "manual",
      tags: [route.routeTag],
      fallback_from: value.fallbackFrom ?? null,
      is_final_success_attempt: status === "success",
      is_user_visible_operation: value.isFinalAttempt ?? true,
    },
    analytics_dimensions: allowedDimensions(
      context.analyticsDimensions,
      snapshot.dimensions.analytics_allowed_keys,
    ),
    result: {
      status,
      http_status: value.httpStatus ?? null,
      latency_ms: value.latencyMs ?? null,
      error_class: value.errorClass ?? null,
    },
    source_cost:
      value.sourceCost === undefined
        ? null
        : {
            amount: value.sourceCost.amount,
            currency: value.sourceCost.currency,
            is_estimated: value.sourceCost.isEstimated ?? false,
          },
    privacy: { contains_prompt: false, contains_response: false },
    usage: value.usage,
  });
}
